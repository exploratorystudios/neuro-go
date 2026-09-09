(function(root,factory){
  const core=typeof module!=="undefined"&&module.exports?require("./go-core.js"):root.NcGoCore;
  const api=factory(core);
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  root.NcGoPlayout=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(C){
  "use strict";

  const{EMPTY,PASS,other,tables,isLegalPlacement,placeStone,isSimpleEye,scoreBoard,libertiesAtLeast,libertyPoints}=C;

  // Place a stone if it is legal and not a plain self-atari. Undo is free when nothing was captured.
  function tryPlace(board,neighbors,diagonals,point,color,ko){
    if(board[point]!==EMPTY||point===ko)return null;
    if(isSimpleEye(board,neighbors,diagonals,point,color))return null;
    if(!isLegalPlacement(board,neighbors,point,color))return null;
    const captured=placeStone(board,neighbors,point,color);
    if(!captured.length&&libertiesAtLeast(board,neighbors,point,2)===1){board[point]=EMPTY;return null}
    const koPoint=captured.length===1&&libertiesAtLeast(board,neighbors,point,2)===1?captured[0]:PASS;
    return{captured:captured.length,ko:koPoint};
  }

  function shuffle(list,random){for(let i=list.length-1;i>0;i--){const j=(random()*(i+1))|0;const t=list[i];list[i]=list[j];list[j]=t}return list}

  // MoGo-style priority: answer atari, then play near the last move, then anywhere.
  function ataricandidates(board,neighbors,point){
    const out=[];
    const consider=q=>{
      if(board[q]===EMPTY)return;
      if(libertiesAtLeast(board,neighbors,q,2)!==1)return;
      const libs=libertyPoints(board,neighbors,q,1);
      if(libs.length)out.push(libs[0]);
    };
    consider(point);
    for(const q of neighbors[point])consider(q);
    return out;
  }

  function step(board,size,neighbors,diagonals,color,ko,order,random,lastMove){
    if(lastMove!==undefined&&lastMove>=0){
      for(const p of shuffle(ataricandidates(board,neighbors,lastMove),random)){
        const placed=tryPlace(board,neighbors,diagonals,p,color,ko);
        if(placed)return{point:p,ko:placed.ko};
      }
      const local=shuffle([...neighbors[lastMove],...diagonals[lastMove]],random);
      for(const p of local){
        const placed=tryPlace(board,neighbors,diagonals,p,color,ko);
        if(placed)return{point:p,ko:placed.ko};
      }
    }
    let count=0;
    for(let p=0;p<board.length;p++)if(board[p]===EMPTY&&p!==ko)order[count++]=p;
    for(let i=count-1;i>0;i--){const j=(random()*(i+1))|0;const t=order[i];order[i]=order[j];order[j]=t}
    for(let i=0;i<count;i++){
      const placed=tryPlace(board,neighbors,diagonals,order[i],color,ko);
      if(placed)return{point:order[i],ko:placed.ko};
    }
    return{point:PASS,ko:PASS};
  }

  // `amaf`, when supplied, records which colour first played each point — the statistic RAVE needs.
  function playout(state,random,{maxMoves=null,amaf=null}={}){
    const size=state.size,{neighbors,diagonals}=tables(size),board=Int8Array.from(state.board),order=new Int32Array(board.length);
    const limit=maxMoves??size*size*2;
    let color=state.toPlay,ko=state.ko,passes=state.passes,moves=0,lastMove=state.lastMove;
    while(passes<2&&moves<limit){
      const played=step(board,size,neighbors,diagonals,color,ko,order,random,lastMove);
      if(played.point!==PASS){
        passes=0;
        if(amaf&&amaf[played.point]===0)amaf[played.point]=color;
      }else passes++;
      ko=played.ko;lastMove=played.point;color=other(color);moves++;
    }
    return scoreBoard(board,size,state.komi);
  }

  function randomMove(state,random){
    const moves=C.legalMoves(state,{includePass:false}),{neighbors,diagonals}=tables(state.size);
    const sensible=moves.filter(p=>!isSimpleEye(state.board,neighbors,diagonals,p,state.toPlay));
    const pool=sensible.length?sensible:moves;
    return pool.length?pool[(random()*pool.length)|0]:PASS;
  }

  return{playout,randomMove,tryPlace};
});
