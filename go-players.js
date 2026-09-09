(function(root,factory){
  const core=typeof module!=="undefined"&&module.exports?require("./go-core.js"):root.NcGoCore;
  const play=typeof module!=="undefined"&&module.exports?require("./go-playout.js"):root.NcGoPlayout;
  const cognitive=typeof module!=="undefined"&&module.exports?require("./go-cognitive.js"):root.NcGoCognitive;
  const mcts=typeof module!=="undefined"&&module.exports?require("./go-mcts.js"):root.NcGoMCTS;
  const regions=typeof module!=="undefined"&&module.exports?require("./go-regions.js"):root.NcGoRegions;
  const api=factory(core,play,cognitive,mcts,regions);
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  root.NcGoPlayers=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(C,P,G,M,R){
  "use strict";

  function randomPolicy(state,random){
    return{point:P.randomMove(state,random),stats:{playouts:0}};
  }

  // Flat Monte Carlo: no tree, every root move gets an equal share of rollouts.
  // Passing joins the ordinary candidate set only once the shared endgame gate says stopping is
  // credible, so flat Monte Carlo cannot learn the same opening-pass failure as the tree search.
  function flatPolicy(state,random,{playouts=400}={}){
    const moves=C.legalMoves(state,{includePass:false}),{neighbors,diagonals}=C.tables(state.size);
    const sensible=moves.filter(p=>!C.isSimpleEye(state.board,neighbors,diagonals,p,state.toPlay));
    const pool=[...(sensible.length?sensible:moves),...(G.passReady(state)?[C.PASS]:[])];
    const each=Math.max(1,Math.floor(playouts/pool.length));
    let best=C.PASS,bestRate=-1,ties=0,used=0;
    for(const point of pool){
      const child=C.play(state,point);if(!child)continue;
      let wins=0;
      for(let i=0;i<each;i++){used++;if(P.playout(child,random).winner===state.toPlay)wins++}
      const rate=wins/each;
      if(rate>bestRate){bestRate=rate;best=point;ties=1}
      else if(rate===bestRate&&random()<1/++ties)best=point;
    }
    return{point:best,stats:{playouts:used,candidates:pool.length,rolloutsPerMove:each,winRate:Number(bestRate.toFixed(3))}};
  }

  // Cognitive-PUCT carries a mind between moves, so plan support accumulates across the match.
  function puctPolicy(state,random,{playouts=2000,mind=null,seed=1,cPuct=1.2,expandThreshold=6,raveBias=.015,fpuReduction=.2,survey=null,regionStrength=.8,fastPlayouts=true,eyeMode="root",eyeWeight=1.1}={}){
    const carried=mind||G.createMind(state.toPlay,seed);
    const decision=M.decide(carried,state,{simulations:playouts,cPuct,expandThreshold,raveBias,fpuReduction,survey,regionStrength,random,fastPlayouts,eyeMode,eyeWeight});
    return{point:decision.point,mind:decision.mind,
      stats:{playouts:decision.stats.playouts,expansions:decision.stats.expansions,
        plan:decision.plan,score:decision.score,maxDepth:decision.stats.maxDepth}};
  }

  // The regional matrix: local analyzers report upward, and their temperatures become the budget the
  // global search spends in each part of the board.
  function matrixPolicy(state,random,options={}){
    const survey=R.survey(state,state.toPlay,options);
    const decision=puctPolicy(state,random,{...options,survey});
    const hottest=survey.reports.slice().sort((a,b)=>b.temperature-a.temperature)[0];
    return{...decision,stats:{...decision.stats,regions:survey.reports.length,
      hottestTemperature:hottest?Number(hottest.temperature.toFixed(3)):0}};
  }

  const POLICIES={
    random:(state,random)=>randomPolicy(state,random),
    flat:(state,random,options)=>flatPolicy(state,random,options),
    puct:(state,random,options)=>puctPolicy(state,random,options),
    matrix:(state,random,options)=>matrixPolicy(state,random,options)
  };
  return{POLICIES,randomPolicy,flatPolicy,puctPolicy,matrixPolicy};
});
