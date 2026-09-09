"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const C=require("../go-core.js");
const Pat=require("../go-patterns.js");
const G=require("../go-cognitive.js");
const M=require("../go-mcts.js");

const at=v=>C.gtpToVertex(9,v);
function position({black=[],white=[],last=null,toPlay=C.BLACK}){
  const state=C.createState(9);
  for(const v of black)state.board[at(v)]=C.BLACK;
  for(const v of white)state.board[at(v)]=C.WHITE;
  state.toPlay=toPlay;state.lastMove=last===null?C.PASS:at(last);
  state.history=[C.hashBoard(state.board,9)];
  return state;
}
const settled=mind=>{let m=mind;return state=>{for(let i=0;i<5;i++)m=G.updatePlans(m,state);return m}};

test("a capturing move outscores a quiet move of the same shape",()=>{
  const state=position({black:["E6","E4","D5"],white:["E5"],last:"E5"});
  const capture=Pat.score(Pat.features(state,at("F5"),C.BLACK,state.lastMove));
  const quiet=Pat.score(Pat.features(state,at("C7"),C.BLACK,state.lastMove));
  assert.ok(capture>quiet+1,`capture ${capture.toFixed(2)} should clear quiet ${quiet.toFixed(2)}`);
});

test("self-atari is recognised and heavily penalised",()=>{
  const state=position({black:["A1"],white:["D6","F6","E7","D5","F5","E4"],last:"E4"});
  const f=Pat.features(state,at("E6"),C.BLACK,state.lastMove);
  assert.equal(f.selfAtari,true,"a lone stone in a white box has one liberty");
  assert.ok(Pat.score(f)<0,"self-atari scores below zero");
});

test("the attack frame takes over when an enemy group is short of liberties",()=>{
  const quiet=position({black:["D4"],white:["F6"]});
  const threat=position({black:["E6","E4","D5"],white:["E5"],last:"E5"});
  assert.equal(settled(G.createMind(C.BLACK,1))(threat).activePlan,"attack");
  assert.notEqual(settled(G.createMind(C.BLACK,1))(quiet).activePlan,"attack");
});

test("frame support decays rather than resetting when evidence disappears",()=>{
  let mind=G.createMind(C.BLACK,1);
  const threat=position({black:["E6","E4","D5"],white:["E5"],last:"E5"});
  for(let i=0;i<5;i++)mind=G.updatePlans(mind,threat);
  const peak=mind.plans.attack;
  const calm=position({black:["D4"],white:["F6"]});
  mind=G.updatePlans(mind,calm);
  assert.ok(mind.plans.attack<peak,"support falls once the threat is gone");
  assert.ok(mind.plans.attack>0,"but is demoted, not forgotten");
});

test("Cognitive-PUCT takes a capture that is on the board",()=>{
  const state=position({black:["E6","E4","D5"],white:["E5"],last:"E5"});
  const decision=M.decide(G.createMind(C.BLACK,1),state,{simulations:600});
  assert.equal(C.vertexToGtp(9,decision.point),"F5");
});

test("Cognitive-PUCT escapes atari instead of leaving the stone to die",()=>{
  const state=position({black:["E5"],white:["E6","E4","D5"],last:"D5"});
  const decision=M.decide(G.createMind(C.BLACK,1),state,{simulations:600});
  const escape=C.vertexToGtp(9,decision.point);
  assert.equal(escape,"F5",`expected the extension, played ${escape}`);
});

test("the search reports a legal move and a governing plan",()=>{
  const decision=M.decide(G.createMind(C.BLACK,1),C.createState(9),{simulations:300});
  assert.ok(C.isLegal(C.createState(9),decision.point));
  assert.ok(G.PLANS.includes(decision.plan));
  assert.equal(decision.stats.playouts>0,true);
});

test("passing is suppressed in the opening and admitted in the endgame",()=>{
  const opening=C.createState(9),mind=G.createMind(C.BLACK,1);
  const openingPass=G.policyPriors(opening,mind,C.legalMoves(opening),{})
    .find(x=>x.point===C.PASS);
  assert.equal(openingPass.score,-Infinity,"an opening pass must not consume search visits");

  const late={...opening,moveNumber:50};
  const latePass=G.policyPriors(late,mind,C.legalMoves(late),{})
    .find(x=>x.point===C.PASS);
  assert.equal(latePass.score,-2.5,"pass becomes a real candidate in the endgame");
});

test("a settled endgame prunes dead points and chooses pass",()=>{
  const state=C.createState(9);
  for(const vertex of ["A2","B1","B2","B3","B4","A4"])
    state.board[C.gtpToVertex(9,vertex)]=C.BLACK;
  for(let point=0;point<state.board.length;point++)if(!state.board[point])state.board[point]=C.WHITE;
  for(const vertex of ["A1","A3"])state.board[C.gtpToVertex(9,vertex)]=C.EMPTY;
  state.history=[C.hashBoard(state.board,9)];
  const decision=M.decide(G.createMind(C.BLACK,1),state,{simulations:40,eyeMode:"root"});
  assert.equal(decision.point,C.PASS);
  assert.equal(decision.stats.rootChildren,1,"only pass should remain after settled-point pruning");
  assert.ok(decision.stats.prunedSettled>=2);
});
