"use strict";
const test=require("node:test");
const assert=require("node:assert");
const C=require("../go-core.js");
const G=require("../go-cognitive.js");
const L=require("../go-ladder.js");

const SIZE=9;
const at=label=>C.gtpToVertex(SIZE,label);

// Positions are built by playing colours explicitly rather than alternating, so a test can set up the
// shape it means without inventing filler moves that change the answer.
function build(list){
  let state=C.createState(SIZE,{komi:7.5,rules:"simple-ko"});
  for(const [colour,label] of list){
    state={...state,toPlay:colour==="b"?C.BLACK:C.WHITE};
    const next=C.play(state,at(label));
    assert.ok(next,`setup move ${colour} ${label} must be legal`);
    state=next;
  }
  return state;
}
// Play a forced sequence out under the real rules: an independent check that a position the reader
// calls "captured" really does lose the stones.
function playOut(state,list){
  let next=state;
  for(const [colour,label] of list){
    next={...next,toPlay:colour==="b"?C.BLACK:C.WHITE};
    const after=C.play(next,at(label));
    assert.ok(after,`${colour} ${label} must be legal`);
    next=after;
  }
  return next;
}
const stonesOf=(state,colour)=>state.board.reduce((n,v)=>n+(v===colour?1:0),0);

// The edge ladder: a black stone in atari against the left edge with a white wall on the B file. It
// runs to the bottom and dies, every time, and the sequence is short enough to write down.
const EDGE_LADDER=[["b","A5"],["w","A6"],["w","B5"]];
const EDGE_RUN=[["b","A4"],["w","B4"],["b","A3"],["w","B3"],["b","A2"],["w","B2"],["b","A1"],["w","B1"]];

test("a group that is caught reads as caught, with either side to move",()=>{
  const state=build(EDGE_LADDER);
  assert.strictEqual(L.read(state.board,SIZE,at("A5"),{attackerToMove:false}),true,
    "black to move and still lost");
  assert.strictEqual(L.read(state.board,SIZE,at("A5"),{attackerToMove:true}),true,
    "white to move captures outright");
});

test("the rules agree: the forced run really does lose every stone",()=>{
  const state=build(EDGE_LADDER);
  const after=playOut({...state,toPlay:C.BLACK},EDGE_RUN);
  assert.strictEqual(stonesOf(after,C.BLACK),0,"the whole running group comes off the board");
});

test("a ladder breaker turns the same shape into an escape",()=>{
  // A friendly stone at B3 is where the chase would have to atari, so the run connects out instead.
  const broken=build([...EDGE_LADDER,["b","B3"]]);
  assert.strictEqual(L.read(broken.board,SIZE,at("A5"),{attackerToMove:false}),false);
  // And the rules agree: three moves in, the group is out of atari for good.
  const after=playOut({...broken,toPlay:C.BLACK},[["b","A4"],["w","B4"],["b","A3"]]);
  const{neighbors}=C.tables(SIZE);
  assert.ok(C.collectGroup(after.board,neighbors,at("A5")).liberties>=3,"connected and free");
});

test("a group with room is never called a ladder",()=>{
  const open=build([["b","E5"],["w","E6"]]);
  assert.strictEqual(L.read(open.board,SIZE,at("E5"),{attackerToMove:true}),false,
    "three liberties is out of ladder range");
  // Two attacking stones on an open board are not enough: the escape runs into space.
  const loose=build([["b","E5"],["w","E6"],["w","D5"]]);
  assert.strictEqual(L.read(loose.board,SIZE,at("E5"),{attackerToMove:true}),false);
});

test("selfAtariLadder sees the move before it is played",()=>{
  const state={...build(EDGE_LADDER),toPlay:C.BLACK};
  assert.strictEqual(L.selfAtariLadder(state,at("A4"),C.BLACK),true,"extending walks into it");
  const broken={...build([...EDGE_LADDER,["b","B3"]]),toPlay:C.BLACK};
  assert.strictEqual(L.selfAtariLadder(broken,at("A4"),C.BLACK),false,"not with a breaker in place");
});

test("a lone stone with no enemy touching it is not a ladder problem",()=>{
  const state=C.createState(SIZE,{komi:7.5});
  const moves=C.legalMoves(state,{includePass:false});
  const mind=G.updatePlans(G.createMind(C.BLACK,1),state);
  const on=G.policyPriors(state,mind,moves,{ladders:true});
  const off=G.policyPriors(state,mind,moves,{ladders:false});
  for(const corner of["A1","A9","J1","J9"]){
    const a=on.find(x=>x.point===at(corner)).score,b=off.find(x=>x.point===at(corner)).score;
    assert.strictEqual(a,b,`${corner} is a bad move for reasons the line prior already covers`);
  }
});

test("laddersEnemy only fires on a chase that actually works",()=>{
  const before={...build([["b","A5"],["w","A6"]]),toPlay:C.WHITE};
  assert.strictEqual(L.laddersEnemy(before,at("B5"),C.WHITE),true,"B5 starts a winning ladder");
  const broken={...build([["b","A5"],["w","A6"],["b","B3"]]),toPlay:C.WHITE};
  assert.strictEqual(L.laddersEnemy(broken,at("B5"),C.WHITE),false,"the breaker makes it pointless");
});

test("an empty point is never a laddered group",()=>{
  const state=build(EDGE_LADDER);
  assert.strictEqual(L.read(state.board,SIZE,at("E5"),{attackerToMove:true}),false);
});

test("the reader answers 'escapes' when it runs out of budget",()=>{
  // The guard must never invent a capture it did not finish reading: an exhausted search says no.
  const state=build(EDGE_LADDER);
  assert.strictEqual(L.read(state.board,SIZE,at("A5"),{attackerToMove:false,budget:0}),false);
});

test("the reader leaves the caller's board untouched",()=>{
  const state=build(EDGE_LADDER);
  const before=Int8Array.from(state.board);
  L.read(state.board,SIZE,at("A5"),{attackerToMove:false});
  L.selfAtariLadder({...state,toPlay:C.BLACK},at("A4"),C.BLACK);
  L.laddersEnemy({...state,toPlay:C.WHITE},at("B4"),C.WHITE);
  assert.deepStrictEqual(Array.from(state.board),Array.from(before));
});

test("the guard demotes a doomed escape in the priors, and only when it is doomed",()=>{
  const state={...build(EDGE_LADDER),toPlay:C.BLACK};
  const moves=C.legalMoves(state,{includePass:false});
  // `defend` is the frame that pays most for rescuing, so it is where the guard has to bite.
  const mind={...G.updatePlans(G.createMind(C.BLACK,1),state),activePlan:"defend"};
  const scoreOf=(list,point)=>list.find(x=>x.point===point).score;
  const off=G.policyPriors(state,mind,moves,{ladders:false});
  const on=G.policyPriors(state,mind,moves,{ladders:true});
  assert.ok(scoreOf(on,at("A4"))<scoreOf(off,at("A4"))-3,"the doomed escape is pushed down hard");

  const broken={...build([...EDGE_LADDER,["b","B3"]]),toPlay:C.BLACK};
  const brokenMoves=C.legalMoves(broken,{includePass:false});
  const brokenMind={...G.updatePlans(G.createMind(C.BLACK,1),broken),activePlan:"defend"};
  const brokenOff=G.policyPriors(broken,brokenMind,brokenMoves,{ladders:false});
  const brokenOn=G.policyPriors(broken,brokenMind,brokenMoves,{ladders:true});
  assert.strictEqual(scoreOf(brokenOn,at("A4")),scoreOf(brokenOff,at("A4")),
    "a rescue that works must not be penalised at all");
});

test("the guard leaves moves that cannot ladder completely alone",()=>{
  // An empty board has no fight on it. A stone on the 1-1 point is strictly capturable in a first-line
  // ladder, and an earlier version of the gate duly penalised every corner: correct, and useless.
  const state=C.createState(SIZE,{komi:7.5});
  const moves=C.legalMoves(state,{includePass:false});
  const mind=G.updatePlans(G.createMind(C.BLACK,1),state);
  const off=G.policyPriors(state,mind,moves,{ladders:false});
  const on=G.policyPriors(state,mind,moves,{ladders:true});
  for(let i=0;i<off.length;i++)assert.strictEqual(on[i].score,off[i].score,"empty board is untouched");
});
