(function(root,factory){
  const core=typeof module!=="undefined"&&module.exports?require("./go-core.js"):root.NcGoCore;
  const cognitive=typeof module!=="undefined"&&module.exports?require("./go-cognitive.js"):root.NcGoCognitive;
  const playout=typeof module!=="undefined"&&module.exports?require("./go-playout.js"):root.NcGoPlayout;
  const eyes=typeof module!=="undefined"&&module.exports?require("./go-eyes.js"):root.NcGoEyes;
  const fastPlayout=typeof module!=="undefined"&&module.exports?require("./go-fastplayout.js"):root.NcGoFastPlayout;
  const style=typeof module!=="undefined"&&module.exports?require("./go-style.js"):root.NcGoStyle;
  const api=factory(core,cognitive,playout,fastPlayout,eyes,style);
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  root.NcGoMCTS=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(C,G,P,FP,E,St){
  "use strict";

  const makeNode=state=>({state,visits:0,valueSum:0,edges:null});

  function terminalValue(state){
    const result=C.score(state);
    return result.winner===state.toPlay?1:-1;
  }
  // Go has no trustworthy static evaluation, so the leaf is a rollout rather than an eval function.
  function leafValue(state,random,options,stats,amaf){
    const roll=options.playoutImpl;
    let total=0;
    for(let i=0;i<options.leafPlayouts;i++){
      stats.playouts++;
      total+=roll(state,random,{amaf,style:options.style}).winner===state.toPlay?1:-1;
    }
    return total/options.leafPlayouts;
  }

  function expand(node,mind,options,stats,eyeSurvey=null){
    let moves=C.legalMoves(node.state,{includePass:true});
    // "tree" re-reads life and death at every node it opens, which costs a survey per expansion;
    // "root" reads it once per move and lets the priors carry it downward.
    const survey=eyeSurvey||(options.eyeMode==="tree"?E.survey(node.state,node.state.toPlay):null);
    if(survey)stats.surveys++;
    // Do not let an opening pass compete with real moves. Once the board is genuinely in the
    // endgame, or every remaining point is Benson-settled, pass is admitted again. Settled points
    // are removed entirely when there is another point to play: a penalty still leaves them as
    // attractive unvisited edges, which is exactly how the old search kept filling dead eyes.
    const ready=G.passReady(node.state,survey);
    const before=moves.length;
    if(!ready)moves=moves.filter(point=>point!==C.PASS);
    if(survey){
      const unsettled=moves.some(point=>point>=0&&!survey.settled[point]);
      const filtered=moves.filter(point=>point===C.PASS||!survey.settled[point]);
      if(unsettled||filtered.length!==moves.length){
        moves=filtered;
        stats.prunedSettled=(stats.prunedSettled||0)+(before-moves.length);
      }
    }
    const ranked=G.policyPriors(node.state,mind,moves,
      {temperature:options.temperature,eyeSurvey:survey,eyeWeight:options.eyeWeight});
    node.edges=ranked.map(x=>({point:x.point,prior:x.prior,policyScore:x.score,visits:0,valueSum:0,
      raveVisits:0,raveValueSum:0,child:null}));
    const total=node.edges.reduce((sum,edge)=>sum+edge.prior,0)||1;
    for(const edge of node.edges)edge.prior/=total;
    stats.expansions++;stats.generated+=moves.length;
  }

  // MC-RAVE: the all-moves-as-first estimate dominates while visits are few, then hands over to Q.
  //
  // First-play urgency: an edge with no visits and no RAVE evidence has to be valued at *something*.
  // Scoring it 0 — an even game — is optimistic wherever the node itself is losing, which is most of
  // this bot's positions, so every untried move outranked the best known one and the search spread
  // itself across the whole board instead of reading anything out. Valuing it at the parent's own
  // value less a reduction that grows as the explored prior mass grows keeps the search concentrated.
  function select(node,cPuct,raveBias,fpuReduction){
    let best=null,bestScore=-Infinity;
    const scale=Math.sqrt(node.visits+1);
    const parentQ=node.visits?node.valueSum/node.visits:0;
    let explored=0;
    for(const edge of node.edges)if(edge.visits)explored+=edge.prior;
    const fpu=parentQ-fpuReduction*Math.sqrt(explored);
    for(const edge of node.edges){
      const n=edge.visits,nr=edge.raveVisits;
      const q=n?edge.valueSum/n:(nr?0:fpu);
      const beta=nr?nr/(n+nr+4*n*nr*raveBias*raveBias):0;
      const blended=beta?(1-beta)*q+beta*(edge.raveValueSum/nr):q;
      const u=cPuct*edge.prior*scale/(1+edge.visits);
      const value=blended+u;
      if(value>bestScore+1e-12||(Math.abs(value-bestScore)<=1e-12&&edge.point<(best?.point??Infinity))){best=edge;bestScore=value}
    }
    return best;
  }

  function simulate(root,mind,random,options,stats,amaf){
    let node=root,depth=0,value;
    amaf.fill(0);
    const nodes=[root],path=[];
    while(true){
      stats.nodes++;
      if(node.state.gameOver){value=terminalValue(node.state);break}
      if(depth>=options.maxDepth){value=leafValue(node.state,random,options,stats,amaf);break}
      if(node.edges===null){
        if(node.visits<options.expandThreshold){value=leafValue(node.state,random,options,stats,amaf);break}
        expand(node,mind,options,stats);
        value=leafValue(node.state,random,options,stats,amaf);break;
      }
      if(!node.edges.length){value=leafValue(node.state,random,options,stats,amaf);break}
      const edge=select(node,options.cPuct,options.raveBias,options.fpuReduction);
      if(!edge.child){
        const state=C.play(node.state,edge.point);
        if(!state){edge.prior=0;stats.illegal++;continue}
        // Superko is enforced at the root only; inside the tree simple ko keeps descent cheap.
        state.rules="simple-ko";state.history=[];
        edge.child=makeNode(state);
      }
      if(edge.point>=0&&amaf[edge.point]===0)amaf[edge.point]=node.state.toPlay;
      path.push(edge);node=edge.child;nodes.push(node);depth++;
    }
    for(const n of nodes)n.visits++;
    // The leaf value is already from the perspective of the leaf's own player to move.
    nodes[nodes.length-1].valueSum+=value;
    for(let i=path.length-1;i>=0;i--){
      value=-value;
      nodes[i].valueSum+=value;
      path[i].visits++;path[i].valueSum+=value;
      // `value` is now from the perspective of whoever moved at nodes[i], which is the perspective
      // every AMAF move by that same colour should be credited with.
      const owner=nodes[i].state.toPlay,edges=nodes[i].edges;
      if(edges)for(const e of edges){
        if(e.point>=0&&amaf[e.point]===owner){e.raveVisits++;e.raveValueSum+=value}
      }
    }
    stats.maxDepth=Math.max(stats.maxDepth,depth);
  }

  // The global brain tilts the search toward hot regions rather than rationing mass region by region.
  // Rationing per region is wrong: a one-point region and a fifty-point contested zone would receive
  // comparable mass, giving the small region an enormous per-point prior. Here each move keeps its own
  // pattern prior and is scaled by how hot its region is relative to the board average.
  function applyRegionAllocation(root,survey,strength){
    const owner=survey.owner,reports=survey.reports;
    if(!reports.length)return 0;
    let mean=0;
    for(const r of reports)mean+=r.temperature;
    mean/=reports.length;
    const factor=reports.map(r=>Math.exp(strength*(r.temperature-mean)));
    const touched=new Set();
    for(const edge of root.edges){
      if(edge.point<0)continue;
      const region=owner[edge.point];
      edge.region=region;edge.regionPrior=edge.prior;
      edge.prior*=factor[region];
      touched.add(region);
    }
    const total=root.edges.reduce((sum,e)=>sum+e.prior,0)||1;
    for(const edge of root.edges)edge.prior/=total;
    return touched.size;
  }

  function decide(sourceMind,state,{simulations=2000,cPuct=1.2,maxDepth=40,expandThreshold=6,leafPlayouts=1,temperature=1,raveBias=.015,fpuReduction=.2,survey=null,regionStrength=.8,random=null,fastPlayouts=true,
  eyeMode="root",eyeWeight=1.1}={}){
    const mind=G.updatePlans(sourceMind,state);
    const draw=random||C.rng((mind.seed+state.moveNumber*7919)>>>0);
    // Only the fast playout can carry a style: the reference playout is the correctness oracle the
    // fast one is checked against, and biasing it would remove the thing it is there to be.
    const personality=mind.personality||null;
    // styleWeight 0 must leave the rollout on exactly the stock path, not on a styled path whose
    // weights all happen to be 1: a uniform weighted draw and a shuffle-and-take-first draw consume the
    // random stream differently, and "the same engine" has to mean the same game.
    const style=personality&&fastPlayouts&&personality.styleWeight>0&&personality.playoutWeight>0&&personality.patterns.size
      ?{table:St.playoutTable(personality,personality.playoutWeight*personality.styleWeight)}:null;
    const options={cPuct,maxDepth,expandThreshold,leafPlayouts,temperature,raveBias,fpuReduction,eyeMode,eyeWeight,style,
      playoutImpl:fastPlayouts?FP.playout:P.playout};
    const amaf=new Int8Array(state.size*state.size);
    const root=makeNode(state);
    const stats={simulations:Math.max(1,simulations|0),nodes:0,expansions:0,generated:0,playouts:0,maxDepth:0,illegal:0,surveys:0,prunedSettled:0};
    // The root is expanded up front so every legal move is available on the very first descent.
    // `updatePlans` has already surveyed this exact position to choose the governing plan, so the root
    // reads life and death for free by reusing that survey.
    const rootEyes=eyeMode==="off"?null:(mind.metrics&&mind.metrics.eyes)||null;
    expand(root,mind,options,stats,rootEyes);
    if(survey)stats.regions=applyRegionAllocation(root,survey,regionStrength);
    for(let i=0;i<stats.simulations;i++)simulate(root,mind,draw,options,stats,amaf);
    const ranked=(root.edges||[]).slice().sort((a,b)=>
      b.visits-a.visits||
      (b.valueSum/Math.max(1,b.visits))-(a.valueSum/Math.max(1,a.visits))||
      b.prior-a.prior);
    const best=ranked[0];
    if(!best)return{mind,point:C.PASS,stats,plan:mind.activePlan,score:null};
    const score=best.visits?best.valueSum/best.visits:0;
    const committed=G.commitDecision(mind,state,best.point,{score});
    return{mind:committed.mind,point:best.point,plan:mind.activePlan,score,message:committed.message,
      stats:{...stats,rootChildren:root.edges.length,rootVisits:root.visits},
      alternatives:ranked.slice(0,3).map(edge=>({move:C.vertexToGtp(state.size,edge.point),visits:edge.visits,
        value:Number((edge.valueSum/Math.max(1,edge.visits)).toFixed(3)),prior:Number(edge.prior.toFixed(3))}))};
  }

  return{decide,applyRegionAllocation};
});
