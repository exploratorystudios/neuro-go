"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const C=require("../go-core.js");
const S=require("../go-score.js");

const at=v=>C.gtpToVertex(9,v);
// White owns everything from column D rightward and seals the A1 corner behind A3-B3-C3-C2-C1.
// The two black stones inside that four-point pocket cannot make two eyes, so they are dead.
function sealedCorner(){
  const state=C.createState(9,{komi:7.5});
  for(let c=3;c<9;c++)for(let r=0;r<9;r++)state.board[r*9+c]=C.WHITE;
  for(const v of["C1","C2","C3","B3","A3"])state.board[at(v)]=C.WHITE;
  for(const v of["A1","B2"])state.board[at(v)]=C.BLACK;
  state.toPlay=C.BLACK;
  state.history=[C.hashBoard(state.board,9)];
  return state;
}

test("Tromp-Taylor counts dead stones for their owner, which is what needs correcting",()=>{
  const raw=C.score(sealedCorner());
  assert.equal(raw.black,2,"the two dead black stones still count as Black's area");
});

test("playing the position out identifies those stones as dead and removes them",()=>{
  const state=sealedCorner();
  const result=S.finalScore(state,{playouts:600,seed:5});
  const dead=result.dead.map(p=>C.vertexToGtp(9,p)).sort();
  assert.deepEqual(dead,["A1","B2"]);
  assert.equal(result.black,0,"with them removed Black holds nothing");
  assert.equal(result.white,81);
});

test("living stones are never removed",()=>{
  // A group with two real eyes is alive and must survive the clean-up, whatever the rollouts do.
  const state=C.createState(9,{komi:7.5});
  for(const v of["A2","B1","B2","B3","B4","A4"])state.board[at(v)]=C.BLACK;
  for(let c=3;c<9;c++)for(let r=0;r<9;r++)state.board[r*9+c]=C.WHITE;
  state.toPlay=C.BLACK;
  state.history=[C.hashBoard(state.board,9)];
  const result=S.finalScore(state,{playouts:600,seed:11});
  for(const v of["A2","B1","B2","B3","B4","A4"])
    assert.ok(!result.dead.includes(at(v)),`${v} is part of a two-eyed group and must not be removed`);
});

test("ownership is decisive on a settled board and undecided on an open one",()=>{
  const settled=S.ownership(sealedCorner(),{playouts:400,seed:3});
  let undecided=0;
  for(const v of settled)if(Math.abs(v)<=.5)undecided++;
  assert.equal(undecided,0,"nothing is in doubt once the board is finished");

  const open=C.createState(9,{komi:7.5});
  open.board[at("E5")]=C.BLACK;
  open.history=[C.hashBoard(open.board,9)];
  const early=S.ownership(open,{playouts:400,seed:3});
  let loose=0;
  for(const v of early)if(Math.abs(v)<=.5)loose++;
  assert.ok(loose>30,`an almost empty board is mostly undecided, got ${loose} of 81`);
});

test("the running estimate reports what is still in dispute",()=>{
  const e=S.estimate(sealedCorner(),{playouts:300,seed:7});
  assert.equal(e.neutral,0);
  assert.ok(e.margin<0,"White is far ahead here");
  assert.equal(e.winner,C.WHITE);
});

// --- settle-then-score -------------------------------------------------------------------------
const G=require("../go-cognitive.js");
const M=require("../go-mcts.js");
const engineMover=(sims=200)=>{
  const minds={};
  return state=>{
    const c=state.toPlay;
    if(!minds[c])minds[c]=G.createMind(c,c*31+7);
    const decision=M.decide(minds[c],state,{simulations:sims,eyeMode:"root"});
    minds[c]=decision.mind;
    return decision.point;
  };
};

test("settling refuses to pass while a move that is not an eye-fill remains",()=>{
  // An engine that always wants to pass must still be made to play the aftermath out, or the dead
  // stones stay on the board and Tromp-Taylor scores them for their owner.
  const state=sealedCorner();
  const result=S.settleAndScore(state,()=>C.PASS);
  assert.ok(result.aftermath>0,"the aftermath was actually played");
  const dead=result.dead.map(p=>C.vertexToGtp(9,p)).sort();
  assert.deepEqual(dead,["A1","B2"],"the dead stones came off even though the mover only passed");
  assert.equal(result.black,0);
});

test("settling leaves a genuinely finished board alone",()=>{
  const state=C.createState(9,{komi:7.5});
  for(const v of["A2","B1","B2","B3","B4","A4"])state.board[at(v)]=C.BLACK;
  for(let c=3;c<9;c++)for(let r=0;r<9;r++)state.board[r*9+c]=C.WHITE;
  state.toPlay=C.BLACK;
  state.history=[C.hashBoard(state.board,9)];
  const result=S.settleAndScore(state,engineMover(150));
  for(const v of["A2","B1","B2","B3","B4","A4"])
    assert.ok(!result.dead.includes(at(v)),`${v} is alive and must survive the settle`);
});

test("settling never fills its own eyes, so a two-eyed group cannot be talked into dying",()=>{
  const state=C.createState(9,{komi:7.5});
  for(const v of["A2","B1","B2","B3","B4","A4"])state.board[at(v)]=C.BLACK;
  state.toPlay=C.WHITE;
  state.history=[C.hashBoard(state.board,9)];
  const settled=S.settle(state,()=>C.PASS).state;
  assert.equal(settled.board[at("A1")],C.EMPTY,"the eye at A1 is still an eye");
  assert.equal(settled.board[at("A3")],C.EMPTY,"and so is the one at A3");
});
