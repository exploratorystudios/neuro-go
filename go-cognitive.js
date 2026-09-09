(function(root,factory){
  const core=typeof module!=="undefined"&&module.exports?require("./go-core.js"):root.NcGoCore;
  const patterns=typeof module!=="undefined"&&module.exports?require("./go-patterns.js"):root.NcGoPatterns;
  const eyes=typeof module!=="undefined"&&module.exports?require("./go-eyes.js"):root.NcGoEyes;
  const api=factory(core,patterns,eyes);
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  root.NcGoCognitive=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(C,Pat,Eyes){
  "use strict";

  const{EMPTY,BLACK,WHITE,PASS,other,tables,collectGroup,scoreBoard}=C;
  const PLANS=["expand","enclose","attack","defend","endgame","live","kill"];
  const clamp=(n,a=0,b=1)=>Math.max(a,Math.min(b,n));

  // One pass over the board: every group, its size and its liberties.
  function survey(state){
    const size=state.size,board=state.board,{neighbors}=tables(size),seen=new Uint8Array(board.length);
    const groups=[];
    for(let p=0;p<board.length;p++){
      if(board[p]===EMPTY||seen[p])continue;
      const group=collectGroup(board,neighbors,p,3);
      for(const stone of group.stones)seen[stone]=1;
      groups.push({color:board[p],stones:group.stones.length,liberties:group.liberties});
    }
    return groups;
  }

  function metrics(state,color){
    const enemy=other(color),groups=survey(state),points=state.size*state.size;
    let ownStones=0,enemyStones=0,ownWeak=0,enemyWeak=0,ownMinLiberties=Infinity;
    for(const g of groups){
      const weak=g.liberties<=2?g.stones:0;
      if(g.color===color){ownStones+=g.stones;ownWeak+=weak;ownMinLiberties=Math.min(ownMinLiberties,g.liberties)}
      else{enemyStones+=g.stones;enemyWeak+=weak}
    }
    const area=scoreBoard(state.board,state.size,state.komi);
    const margin=color===BLACK?area.margin:-area.margin;
    // The eye layer's aggregates. `ownAtRisk` is the share of our stones in groups that have neither
    // two eyes nor room to make them — the quantity that was silently running to 100% in every loss.
    const eyeSurvey=Eyes.survey(state,color);
    const ownTotal=Math.max(1,ownStones),enemyTotal=Math.max(1,enemyStones);
    return{stage:clamp(state.moveNumber/points),occupancy:clamp((ownStones+enemyStones)/points),
      eyes:eyeSurvey,
      ownAtRisk:clamp((eyeSurvey.ownCritical+.5*eyeSurvey.ownUnsettled)/ownTotal),
      enemyAtRisk:clamp((eyeSurvey.enemyCritical+.5*eyeSurvey.enemyUnsettled)/enemyTotal),
      ownSettled:clamp(eyeSurvey.ownAliveStones/ownTotal),
      territory:clamp(margin/points,-1,1),
      ownStones,enemyStones,
      ownDanger:clamp(ownWeak/Math.max(1,ownStones)),
      enemyDanger:clamp(enemyWeak/Math.max(1,enemyStones)),
      ownMinLiberties:Number.isFinite(ownMinLiberties)?ownMinLiberties:4};
  }

  function createMind(color,seed=1){
    return{color,seed,plans:Object.fromEntries(PLANS.map(id=>[id,.2])),activePlan:"expand",
      lastScore:null,history:[]};
  }
  const copyMind=mind=>({...mind,plans:{...mind.plans},history:mind.history.slice(-12)});

  // Raw evidence for each plan, before the mind's own accumulated preference is folded in.
  function activation(m){
    return{
      expand:clamp(.75*(1-m.occupancy)+.2*(1-m.stage)),
      enclose:clamp(.35+.5*Math.max(0,m.territory)+.3*m.occupancy-.3*m.ownDanger),
      attack:clamp(1.15*m.enemyDanger+.15*Math.max(0,m.territory)),
      defend:clamp(1.25*m.ownDanger+(m.ownMinLiberties<=2?.25:0)),
      endgame:clamp(.9*m.stage+.5*m.occupancy-.4),
      // Living comes before everything else: a group without eyes is worth no points at all, which is
      // why the losses were whole-board rather than narrow. Kill is its mirror against the opponent.
      live:clamp(1.35*m.ownAtRisk-.35*m.ownSettled),
      kill:clamp(1.15*m.enemyAtRisk+.2*Math.max(0,m.territory))
    };
  }

  // Support decays rather than resetting, so a plan that stops paying off is demoted, not forgotten.
  function updatePlans(mind,state){
    const m=metrics(state,mind.color),evidence=activation(m),next=copyMind(mind);
    for(const id of PLANS)next.plans[id]=clamp(next.plans[id]*.72+evidence[id]*.42,0,1.2);
    let best="expand",bestWeight=-Infinity;
    for(const id of PLANS)if(next.plans[id]>bestWeight){bestWeight=next.plans[id];best=id}
    next.activePlan=best;next.metrics=m;
    return next;
  }

  // Passing is a legal move at every point in Go, but it is not a useful search branch in the
  // opening. A rollout can make an early pass look harmless because the opponent also passes at
  // the end of the random continuation, and MCTS can then spend real visits on that branch. Keep
  // pass out of the tree until enough of the board has been played to make "stop" a credible choice.
  // A complete Benson survey is an exception: if every remaining legal point is already settled,
  // passing is safe even when a compact position reached that state early.
  function passReady(state,eyeSurvey=null){
    const placements=C.legalMoves(state,{includePass:false});
    if(!placements.length)return true;
    if(eyeSurvey&&placements.every(point=>eyeSurvey.settled&&eyeSurvey.settled[point]))return true;
    let stones=0;
    for(const value of state.board)if(value!==EMPTY)stones++;
    const points=state.size*state.size;
    return Math.max(state.moveNumber,stones)>=points*.55;
  }

  const FRAME_BONUS={
    expand:f=>(f.line>=2?.55:0)+(f.friendly===0?.35:0)-(f.contact?.2:0),
    enclose:f=>.4*Math.min(f.friendly,2)+(f.line>=1&&f.line<=3?.3:0),
    attack:f=>.85*Math.log1p(f.threaten)+.4*Math.min(f.contact,2),
    defend:f=>1.0*Math.log1p(f.rescue)+.3*Math.min(f.liberties,3)-(f.selfAtari?.8:0),
    endgame:f=>.5*Math.min(f.contact,2)+(f.line<=1?.35:0),
    live:f=>1.1*Math.log1p(f.rescue)+.35*Math.min(f.liberties,4)-(f.selfAtari?1.2:0),
    kill:f=>1.0*Math.log1p(f.threaten)+.45*Math.min(f.contact,2)
  };

  // `eyeSurvey`, when supplied, contributes two things the pattern features cannot express: a bonus on
  // the specific points that make or break an eye, and a hard penalty on points inside territory that
  // Benson's algorithm has *proved* settled. The second is a prune rather than a re-weight — it says
  // "there is nothing here to search", which is the one thing the regional matrix was never able to say.
  function policyPriors(state,mind,moves,{temperature=1,eyeSurvey=null,eyeWeight=1.1}={}){
    const bonus=FRAME_BONUS[mind.activePlan]||FRAME_BONUS.expand;
    const vital=eyeSurvey?eyeSurvey.vital:null,settled=eyeSurvey?eyeSurvey.settled:null;
    const allowPass=passReady(state,eyeSurvey);
    const scored=moves.map(point=>{
      if(point===PASS)return{point,score:allowPass?-2.5:-Infinity,features:null};
      const f=Pat.features(state,point,state.toPlay,state.lastMove);
      let value=Pat.score(f)+bonus(f);
      if(vital)value+=eyeWeight*vital[point];
      if(settled&&settled[point])value-=3.5;
      return{point,score:value,features:f};
    });
    const priors=Pat.softmax(scored.map(x=>x.score),temperature);
    return scored.map((x,i)=>({point:x.point,prior:priors[i],score:x.score}));
  }

  // Reinforce the governing plan when the search agrees with it, demote it when it does not.
  function commitDecision(mind,state,point,{score=0}={}){
    const next=copyMind(mind),plan=next.activePlan;
    if(next.lastScore!==null){
      const delta=score-next.lastScore;
      next.plans[plan]=clamp(next.plans[plan]+(delta>=0?.12:-.18),0,1.2);
    }
    next.lastScore=score;
    next.history.push({move:point,plan,score:Number(score.toFixed(3)),moveNumber:state.moveNumber});
    return{mind:next,message:`${plan} (${(next.plans[plan]).toFixed(2)})`};
  }

  return{PLANS,survey,metrics,createMind,copyMind,activation,updatePlans,policyPriors,commitDecision,FRAME_BONUS,passReady};
});
