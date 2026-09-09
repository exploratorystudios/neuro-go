(function(root,factory){
  const core=typeof module!=="undefined"&&module.exports?require("./go-core.js"):root.NcGoCore;
  const fastPlayout=typeof module!=="undefined"&&module.exports?require("./go-fastplayout.js"):root.NcGoFastPlayout;
  const api=factory(core,fastPlayout);
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  root.NcGoScore=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(C,FP){
  "use strict";

  const EMPTY=0,BLACK=1,WHITE=2;

  // Tromp-Taylor area scoring is only correct on a board played to the bitter end, because it removes
  // no dead stones: a dead group still counts as its owner's territory. That is why the engine must
  // capture everything before it will agree the game is over, which to a human looks like it does not
  // know the game has finished.
  //
  // The fix is the standard one: play the position out many times and count who ends up owning each
  // point. A stone standing on a point its opponent owns in almost every continuation is dead, whoever
  // it belongs to now. Remove those stones, then score the cleaned board.
  function ownership(state,{playouts=800,seed=1,random=null}={}){
    const points=state.size*state.size,acc=new Float32Array(points);
    const draw=random||C.rng((seed*2654435761)>>>0);
    for(let i=0;i<playouts;i++)FP.playoutOwnership(state,draw,acc);
    for(let i=0;i<points;i++)acc[i]/=playouts;
    return acc;   // +1 held by Black in every continuation, -1 by White, 0 genuinely neutral
  }

  // Ownership-thresholded removal. Superseded by `settleAndScore` below, which is both cheaper and
  // markedly more accurate; this is kept because it needs no engine, and `ownership` is still the right
  // tool for asking *how much of the board is genuinely in dispute*, which a single settled line cannot
  // answer. Audited against GNU Go on 30 real games stopped 20 moves early: 25/30 exact, mean error 1.7
  // points, worst 24 — against 29/30, 0.1 and 4 for `settleAndScore`.
  //
  // `threshold` is how one-sided a point's ownership must be before a stone standing on it is called
  // dead. High values are conservative: they leave a contested stone on the board rather than take it
  // off, which is the safer error when the two players still disagree.
  function finalScore(state,{playouts=800,seed=1,threshold=.7,random=null}={}){
    const own=ownership(state,{playouts,seed,random});
    const board=Int8Array.from(state.board),dead=[];
    for(let p=0;p<board.length;p++){
      const stone=board[p];
      if(stone===EMPTY)continue;
      if(stone===BLACK&&own[p]<-threshold){dead.push(p);board[p]=EMPTY}
      else if(stone===WHITE&&own[p]>threshold){dead.push(p);board[p]=EMPTY}
    }
    const result=C.scoreBoard(board,state.size,state.komi);
    return{...result,dead,ownership:own,removed:dead.length};
  }

  // A running estimate while the game is still going, for a score readout that means something before
  // the board is finished.
  function estimate(state,{playouts=300,seed=1,random=null}={}){
    const own=ownership(state,{playouts,seed,random});
    let black=0,white=0,neutral=0;
    for(let i=0;i<own.length;i++){
      if(own[i]>.5)black++;else if(own[i]<-.5)white++;else neutral++;
    }
    return{black,white,neutral,komi:state.komi,margin:black-white-state.komi,
      winner:black-white-state.komi>0?BLACK:WHITE,ownership:own};
  }

  // ---------------------------------------------------------------------------------------------
  // Settle-then-score. Tromp-Taylor is *exact* on a board played to completion — audited against GNU
  // Go's own final_score on 30 finished games, it matched all 30 to the point. Every error it makes is
  // therefore an error about the board not being finished, not about the arithmetic. So rather than
  // estimate which stones would have died, finish the game and look.
  //
  // This is the same method the benchmark already trusts: GNU Go is launched with `--capture-all-dead
  // --play-out-aftermath` precisely so that Tromp-Taylor becomes valid against it. Here the engine
  // plays both sides of the aftermath instead.
  //
  // `chooseMove(state)` is supplied by the caller so this file need not depend on the search, which
  // depends on it. Pass a real engine for accuracy, or a playout policy for speed.
  function settle(state,chooseMove,{maxMoves=400}={}){
    // Superko is dropped for the aftermath: it only descends, and a repetition here just wastes a move.
    let s={...state,rules:"simple-ko",history:[],gameOver:false,
      board:Int8Array.from(state.board),captures:{...state.captures},moveCap:maxMoves};
    const{neighbors,diagonals}=C.tables(state.size);
    let moves=0;
    while(!s.gameOver&&moves<maxMoves){
      // Passing is not allowed while a move remains that does not fill one's own eye. This is the whole
      // point of the exercise: an engine plays to *win*, so the moment it is ahead it passes and leaves
      // the dead stones standing — which is precisely the position we are trying to resolve. Refusing
      // the pass forces the aftermath to be played out, and only then is Tromp-Taylor valid.
      const legal=C.legalMoves(s,{includePass:false});
      const sensible=legal.filter(p=>!C.isSimpleEye(s.board,neighbors,diagonals,p,s.toPlay));
      let point;
      if(!sensible.length)point=C.PASS;
      else{
        try{point=chooseMove(s)}catch(err){point=null}
        if(point===undefined||point===null||point===C.PASS||!sensible.includes(point))
          point=sensible[(moves*2654435761>>>0)%sensible.length];
      }
      const next=C.play(s,point);
      if(!next)break;
      s=next;moves++;
    }
    return{state:s,aftermath:moves};
  }

  // The stones that were on the board at the start and are not there at the end: the dead ones.
  function removedStones(before,after){
    const dead=[];
    for(let p=0;p<before.length;p++){
      const was=before[p];
      if(was!==EMPTY&&after[p]!==was)dead.push(p);
    }
    return dead;
  }

  function settleAndScore(state,chooseMove,options={}){
    const played=settle(state,chooseMove,options);
    const result=C.scoreBoard(played.state.board,state.size,state.komi);
    const dead=removedStones(state.board,played.state.board);
    return{...result,dead,removed:dead.length,aftermath:played.aftermath,settled:played.state};
  }

  return{ownership,finalScore,estimate,settle,settleAndScore,removedStones};
});
