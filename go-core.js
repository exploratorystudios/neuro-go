(function(root,factory){
  const api=factory();
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  root.NcGoCore=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  const EMPTY=0,BLACK=1,WHITE=2,PASS=-1;
  const other=color=>color===BLACK?WHITE:BLACK;
  const colorName=color=>color===BLACK?"black":"white";
  const colorFrom=name=>String(name).toLowerCase()[0]==="b"?BLACK:WHITE;
  const LETTERS="ABCDEFGHJKLMNOPQRSTUVWXYZ";

  const NEIGHBORS=new Map(),DIAGONALS=new Map(),ZOBRIST=new Map(),SCRATCH=new Map();

  function rng(seed){let value=seed>>>0;return()=>{value=(Math.imul(value,1664525)+1013904223)>>>0;return value/4294967296}}

  function tables(size){
    let table=NEIGHBORS.get(size);
    if(table)return{neighbors:table,diagonals:DIAGONALS.get(size)};
    const n=[],d=[];
    for(let r=0;r<size;r++)for(let c=0;c<size;c++){
      const straight=[],corner=[];
      if(r>0)straight.push((r-1)*size+c);
      if(r<size-1)straight.push((r+1)*size+c);
      if(c>0)straight.push(r*size+c-1);
      if(c<size-1)straight.push(r*size+c+1);
      for(const [dr,dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]){
        const rr=r+dr,cc=c+dc;
        if(rr>=0&&rr<size&&cc>=0&&cc<size)corner.push(rr*size+cc);
      }
      n.push(straight);d.push(corner);
    }
    NEIGHBORS.set(size,n);DIAGONALS.set(size,d);return{neighbors:n,diagonals:d};
  }

  // Board-only Zobrist keys, seeded per size so hashes are stable across processes.
  function zobrist(size){
    let table=ZOBRIST.get(size);
    if(table)return table;
    const random=rng(0x5eed0000^size),points=size*size;
    table=[new Int32Array(points),new Int32Array(points)];
    for(let i=0;i<points;i++){table[0][i]=(random()*4294967296)|0;table[1][i]=(random()*4294967296)|0}
    ZOBRIST.set(size,table);return table;
  }
  function hashBoard(board,size){
    const table=zobrist(size);let hash=0;
    for(let i=0;i<board.length;i++){const stone=board[i];if(stone!==EMPTY)hash=(hash^table[stone-1][i])|0}
    return hash;
  }

  function scratch(size,slot){
    const key=`${size}:${slot}`;let s=SCRATCH.get(key);
    if(!s){s={mark:new Int32Array(size*size),gen:0,stack:new Int32Array(size*size)};SCRATCH.set(key,s)}
    s.gen++;return s;
  }

  function collectGroup(board,neighbors,point,slot=0){
    const size=Math.round(Math.sqrt(board.length)),s=scratch(size,slot),color=board[point],stones=[];
    let top=0,liberties=0;
    s.stack[top++]=point;s.mark[point]=s.gen;
    while(top){
      const p=s.stack[--top];stones.push(p);
      for(const q of neighbors[p]){
        if(s.mark[q]===s.gen)continue;
        if(board[q]===EMPTY){s.mark[q]=s.gen;liberties++}
        else if(board[q]===color){s.mark[q]=s.gen;s.stack[top++]=q}
      }
    }
    return{stones,liberties};
  }

  // Liberty count that early-exits at `cap` and allocates nothing. Playouts call this constantly.
  function libertiesAtLeast(board,neighbors,point,cap=Infinity){
    const size=Math.round(Math.sqrt(board.length)),s=scratch(size,4),color=board[point];
    let top=0,liberties=0;
    s.stack[top++]=point;s.mark[point]=s.gen;
    while(top){
      const p=s.stack[--top];
      for(const q of neighbors[p]){
        if(s.mark[q]===s.gen)continue;
        if(board[q]===EMPTY){s.mark[q]=s.gen;if(++liberties>=cap)return liberties}
        else if(board[q]===color){s.mark[q]=s.gen;s.stack[top++]=q}
      }
    }
    return liberties;
  }
  function libertyCount(board,neighbors,point){return libertiesAtLeast(board,neighbors,point)}
  // The liberties themselves, capped. Used to find the escape point of a group in atari.
  function libertyPoints(board,neighbors,point,cap=Infinity){
    const size=Math.round(Math.sqrt(board.length)),s=scratch(size,5),color=board[point],found=[];
    let top=0;
    s.stack[top++]=point;s.mark[point]=s.gen;
    while(top){
      const p=s.stack[--top];
      for(const q of neighbors[p]){
        if(s.mark[q]===s.gen)continue;
        if(board[q]===EMPTY){s.mark[q]=s.gen;found.push(q);if(found.length>=cap)return found}
        else if(board[q]===color){s.mark[q]=s.gen;s.stack[top++]=q}
      }
    }
    return found;
  }

  // Legal without playing it out: an empty neighbour, a breathing friend, or a capture.
  function isLegalPlacement(board,neighbors,point,color){
    if(board[point]!==EMPTY)return false;
    const enemy=other(color);
    for(const q of neighbors[point])if(board[q]===EMPTY)return true;
    for(const q of neighbors[point]){
      if(board[q]===color&&libertiesAtLeast(board,neighbors,q,2)>1)return true;
      if(board[q]===enemy&&libertiesAtLeast(board,neighbors,q,2)===1)return true;
    }
    return false;
  }

  // Placement is assumed legal. Returns the captured points.
  function placeStone(board,neighbors,point,color){
    board[point]=color;
    const enemy=other(color),captured=[];
    for(const q of neighbors[point]){
      if(board[q]!==enemy)continue;
      const group=collectGroup(board,neighbors,q);
      if(group.liberties)continue;
      for(const stone of group.stones){board[stone]=EMPTY;captured.push(stone)}
    }
    return captured;
  }

  // A single-stone capture that leaves the capturer in atari is the ko shape.
  function koPointAfter(board,neighbors,point,captured){
    if(captured.length!==1)return PASS;
    const group=collectGroup(board,neighbors,point);
    return group.stones.length===1&&group.liberties===1?captured[0]:PASS;
  }

  function isSimpleEye(board,neighbors,diagonals,point,color){
    if(board[point]!==EMPTY)return false;
    for(const q of neighbors[point])if(board[q]!==color)return false;
    const enemy=other(color),corners=diagonals[point];
    let hostile=0;
    for(const q of corners)if(board[q]===enemy)hostile++;
    // On the edge a single hostile diagonal already breaks the eye.
    return corners.length<4?hostile===0:hostile<=1;
  }

  function createState(size=9,{komi=7.5,rules="positional-superko",moveCap=null}={}){
    return{size,komi,rules,board:new Int8Array(size*size),toPlay:BLACK,ko:PASS,passes:0,moveNumber:0,lastMove:PASS,
      captures:{1:0,2:0},history:[hashBoard(new Int8Array(size*size),size)],
      moveCap:moveCap===null?size*size*2:moveCap,gameOver:false,result:null};
  }

  function clone(state){
    return{...state,board:Int8Array.from(state.board),captures:{...state.captures},history:state.history.slice()};
  }

  function isLegal(state,point){
    if(state.gameOver)return false;
    if(point===PASS)return true;
    if(point<0||point>=state.board.length)return false;
    if(point===state.ko)return false;
    const{neighbors}=tables(state.size);
    if(!isLegalPlacement(state.board,neighbors,point,state.toPlay))return false;
    if(state.rules!=="positional-superko")return true;
    const probe=Int8Array.from(state.board);
    placeStone(probe,neighbors,point,state.toPlay);
    return!state.history.includes(hashBoard(probe,state.size));
  }

  function legalMoves(state,{includePass=true}={}){
    const moves=[];
    if(state.gameOver)return moves;
    for(let p=0;p<state.board.length;p++)if(isLegal(state,p))moves.push(p);
    if(includePass)moves.push(PASS);
    return moves;
  }

  function play(state,point){
    if(!isLegal(state,point))return null;
    const next=clone(state),{neighbors}=tables(state.size);
    next.moveNumber++;next.lastMove=point;
    if(point===PASS){
      next.passes++;next.ko=PASS;next.toPlay=other(state.toPlay);
      if(next.passes>=2){next.gameOver=true;next.result="two-passes"}
    }else{
      const captured=placeStone(next.board,neighbors,point,state.toPlay);
      next.captures[state.toPlay]+=captured.length;
      next.ko=koPointAfter(next.board,neighbors,point,captured);
      next.passes=0;next.toPlay=other(state.toPlay);
      next.history.push(hashBoard(next.board,state.size));
    }
    if(!next.gameOver&&next.moveCap&&next.moveNumber>=next.moveCap){next.gameOver=true;next.result="move-cap"}
    return next;
  }

  // Tromp-Taylor area scoring: stones plus the empty regions reaching exactly one colour.
  function scoreBoard(board,size,komi){
    const{neighbors}=tables(size),s=scratch(size,1);
    let black=0,white=0;
    for(let p=0;p<board.length;p++){
      if(board[p]===BLACK)black++;else if(board[p]===WHITE)white++;
      if(board[p]!==EMPTY||s.mark[p]===s.gen)continue;
      const region=[];let top=0,reachBlack=false,reachWhite=false;
      s.stack[top++]=p;s.mark[p]=s.gen;
      while(top){
        const q=s.stack[--top];region.push(q);
        for(const n of neighbors[q]){
          if(board[n]===EMPTY){if(s.mark[n]!==s.gen){s.mark[n]=s.gen;s.stack[top++]=n}}
          else if(board[n]===BLACK)reachBlack=true;else reachWhite=true;
        }
      }
      if(reachBlack&&!reachWhite)black+=region.length;
      else if(reachWhite&&!reachBlack)white+=region.length;
    }
    const margin=black-white-komi;
    return{black,white,komi,margin,winner:margin>0?BLACK:WHITE};
  }
  const score=state=>scoreBoard(state.board,state.size,state.komi);

  function vertexToGtp(size,point){
    if(point===PASS)return"pass";
    const r=Math.floor(point/size),c=point%size;
    return`${LETTERS[c]}${size-r}`;
  }
  function gtpToVertex(size,text){
    const token=String(text).trim().toUpperCase();
    if(token==="PASS")return PASS;
    if(token==="RESIGN")return"resign";
    const c=LETTERS.indexOf(token[0]),row=parseInt(token.slice(1),10);
    if(c<0||!Number.isFinite(row)||row<1||row>size)return null;
    return(size-row)*size+c;
  }
  function render(state){
    const size=state.size,rows=[];
    for(let r=0;r<size;r++){
      const line=[];
      for(let c=0;c<size;c++){const stone=state.board[r*size+c];line.push(stone===BLACK?"X":stone===WHITE?"O":".")}
      rows.push(`${String(size-r).padStart(2)} ${line.join(" ")}`);
    }
    rows.push(`   ${LETTERS.slice(0,size).split("").join(" ")}`);
    return rows.join("\n");
  }

  return{EMPTY,BLACK,WHITE,PASS,other,colorName,colorFrom,tables,createState,clone,isLegal,legalMoves,play,score,scoreBoard,
    collectGroup,libertyCount,libertiesAtLeast,libertyPoints,isLegalPlacement,placeStone,isSimpleEye,hashBoard,rng,vertexToGtp,gtpToVertex,render};
});
