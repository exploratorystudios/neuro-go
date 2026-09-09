(function(root,factory){
  const req=typeof module!=="undefined"&&module.exports;
  const core=req?require("./go-core.js"):root.NcGoCore;
  const cognitive=req?require("./go-cognitive.js"):root.NcGoCognitive;
  const players=req?require("./go-players.js"):root.NcGoPlayers;
  const score=req?require("./go-score.js"):root.NcGoScore;
  const api=factory(core,cognitive,players,score);
  if(req)module.exports=api;
  root.NcGoSession=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(C,G,PL,S){
  "use strict";

  const SIZE=9,KOMI=7.5;
  const MOVE_CAP=SIZE*SIZE*3;

  // The web session is stateless: the client owns the move list and the server replays it. That keeps
  // the whole thing deployable to a serverless platform, where nothing survives between requests.
  function createGame(){return C.createState(SIZE,{komi:KOMI,moveCap:MOVE_CAP})}

  function replay(moves){
    let state=createGame();
    const history=[];
    for(const point of moves||[]){
      const color=state.toPlay,next=C.play(state,point);
      if(!next)throw new Error(`Illegal move in history: ${C.vertexToGtp(SIZE,point)}`);
      state=next;history.push(entry(color,point));
    }
    return{state,history};
  }

  function entry(color,point){
    return{color:C.colorName(color),point,label:C.vertexToGtp(SIZE,point),pass:point===C.PASS};
  }

  // A mind is meant to carry between moves, so a warm process reuses it whenever the incoming move
  // list extends the one it last answered. A cold process just starts a fresh mind: the search is
  // still correct, it has simply forgotten the plans it had built up.
  const carried={key:null,mind:null};
  function mindFor(moves,color,seed){
    const key=moves.join(",");
    if(carried.mind&&carried.key!==null&&key.startsWith(carried.key)&&carried.color===color)return carried.mind;
    return G.createMind(color,seed);
  }
  function remember(moves,mind,color){carried.key=moves.join(",");carried.mind=mind;carried.color=color}

  function engineReply(state,moves,{playouts=2000,seed=1}={}){
    const random=C.rng((seed*2654435761)>>>0);
    const color=state.toPlay;
    const decision=PL.puctPolicy(state,random,{playouts,mind:mindFor(moves,color,seed),seed,
      eyeMode:"root",eyeWeight:1.1,fastPlayouts:true});
    const next=C.play(state,decision.point);
    if(!next)throw new Error("The engine selected an illegal move");
    const played=moves.concat([decision.point]);
    remember(played,decision.mind,color);
    return{state:next,moves:played,entry:entry(color,decision.point)};
  }

  const winnerName=margin=>margin>0?"Black":"White";

  function resultText(state,settled){
    if(!state.gameOver)return null;
    const margin=settled.margin,side=winnerName(margin),by=Math.abs(margin).toFixed(1);
    const how=state.result==="move-cap"?"move cap reached":"both players passed";
    return`${side} wins by ${by} (${how})`;
  }

  // Dead-stone reading, recomputed from scratch every move so the overlay tracks the live position.
  // Ownership is thresholded high on purpose: a stone in trouble is not yet a dead stone, and leaving
  // a contested stone on the board is the safer error while the players still disagree about it.
  function readDead(state,{playouts=600,seed=1,threshold=.8}={}){
    if(state.moveNumber===0)return{dead:[],score:C.score(state)};
    const settled=S.finalScore(state,{playouts,seed,threshold});
    return{dead:settled.dead,score:{black:settled.black,white:settled.white,komi:settled.komi,
      margin:settled.margin,winner:settled.winner}};
  }

  function snapshot(state,moves,history,{deadPlayouts=600,seed=1}={}){
    const raw=C.score(state),settled=readDead(state,{playouts:deadPlayouts,seed});
    const last=history.length?history[history.length-1]:null;
    return{
      size:state.size,komi:state.komi,board:Array.from(state.board),toPlay:C.colorName(state.toPlay),
      passes:state.passes,moveNumber:state.moveNumber,lastMove:state.lastMove,
      gameOver:state.gameOver,ending:state.result,
      // `lastMove` is -1 after a pass, so nothing on the board is ever marked as the latest move
      // once a player has passed. `lastAction` says what actually just happened, in words.
      lastAction:last,
      score:raw,deadScore:settled.score,dead:settled.dead,
      result:resultText(state,settled.score),
      moves:moves.slice(),history:history.slice(-16)
    };
  }

  // One request, one answer: replay what the client has, optionally add its move, then let the engine
  // reply if it is its turn.
  function advance(moves,point,{playouts=2000,deadPlayouts=600,seed=1}={}){
    let{state,history}=replay(moves||[]);
    let list=(moves||[]).slice();
    if(point!==undefined&&point!==null){
      if(state.gameOver)throw new Error("The game is over");
      if(state.toPlay!==C.BLACK)throw new Error("It is not your turn");
      if(!Number.isInteger(point)||!C.isLegal(state,point))throw new Error("Illegal move");
      const color=state.toPlay;
      state=C.play(state,point);list=list.concat([point]);history.push(entry(color,point));
    }
    if(!state.gameOver&&state.toPlay===C.WHITE){
      const reply=engineReply(state,list,{playouts,seed});
      state=reply.state;list=reply.moves;history.push(reply.entry);
    }
    return snapshot(state,list,history,{deadPlayouts,seed});
  }

  return{SIZE,KOMI,createGame,replay,advance,snapshot,engineReply,readDead,entry};
});
