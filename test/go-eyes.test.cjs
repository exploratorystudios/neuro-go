"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const C=require("../go-core.js");
const E=require("../go-eyes.js");

const at=v=>C.gtpToVertex(9,v);
function position({black=[],white=[],toPlay=C.BLACK}={}){
  const state=C.createState(9);
  for(const v of black)state.board[at(v)]=C.BLACK;
  for(const v of white)state.board[at(v)]=C.WHITE;
  state.toPlay=toPlay;
  state.history=[C.hashBoard(state.board,9)];
  return state;
}
const alive=(state,color)=>[...E.bensonAlive(state.board,9,color)].filter(v=>v===1).length;
const territory=(state,color)=>[...E.bensonAlive(state.board,9,color)]
  .map((v,i)=>v===2?C.vertexToGtp(9,i):null).filter(Boolean);
function vitalPoints(state,color){
  const survey=E.survey(state,color);
  return [...survey.vital].map((w,i)=>[w,i]).filter(x=>x[0]>0)
    .sort((a,b)=>b[0]-a[0]).map(([,i])=>C.vertexToGtp(9,i));
}

test("Benson: a group with two one-point eyes is unconditionally alive",()=>{
  const state=position({black:["A2","B1","B2","B3","B4","A4"]});
  assert.equal(alive(state,C.BLACK),6,"every stone of the group is pass-alive");
  assert.deepEqual(territory(state,C.BLACK).sort(),["A1","A3"],"and exactly its two eyes are settled");
});

test("Benson: filling one of the two eyes destroys unconditional life",()=>{
  const state=position({black:["A2","B1","B2","B3","B4","A4","A3"]});
  assert.equal(alive(state,C.BLACK),0);
});

test("Benson: a single two-point eye is not enough",()=>{
  assert.equal(alive(position({black:["A3","B3","B2","B1"]}),C.BLACK),0);
});

test("Benson is unaffected by anything the opponent does outside",()=>{
  const bare=position({black:["A2","B1","B2","B3","B4","A4"]});
  const besieged=position({black:["A2","B1","B2","B3","B4","A4"],
    white:["D1","D2","D3","D4","D5","C5","B5","A5"]});
  assert.equal(alive(besieged,C.BLACK),alive(bare,C.BLACK),"unconditional means unconditional");
});

test("unconditional territory is the vital regions only, not every enclosed one",()=>{
  // A lone live group on an otherwise bare board encloses the whole rest of the board, but the
  // opponent can plainly still live out there, so it must not be claimed.
  const state=position({black:["A2","B1","B2","B3","B4","A4"]});
  assert.ok(!territory(state,C.BLACK).includes("J9"),"the far corner is not settled territory");
});

test("eye space is graded by shape, not size: square four is one eye, straight four is more",()=>{
  const square=E.eyeValue(4,false),straight=E.eyeValue(4,true);
  assert.ok(square<2,"a square four cannot be split and is a single eye");
  assert.ok(straight>square,"a four that can be split is worth more");
  assert.equal(E.eyeValue(7,false),2,"a large enclosed space always yields two eyes");
});

test("the dividing points of a straight three are its splitting points",()=>{
  const{neighbors}=C.tables(9);
  const cells=[at("A1"),at("B1"),at("C1")];
  const splits=E.dividingPoints(cells,9,neighbors).map(p=>C.vertexToGtp(9,p));
  assert.deepEqual(splits,["B1"],"only the middle point splits a straight three");
  assert.deepEqual(E.dividingPoints([at("A1"),at("B1"),at("A2"),at("B2")],9,neighbors),[],
    "a square four has no dividing point, which is why it is dead");
});

test("the survey names the point that saves a group in atari",()=>{
  const state=position({black:["E5"],white:["E6","E4","D5"]});
  assert.equal(vitalPoints(state,C.BLACK)[0],"F5","the last liberty is the vital point");
});

test("the survey names the point that kills a group in atari",()=>{
  const state=position({black:["E6","E4","D5"],white:["E5"]});
  assert.equal(vitalPoints(state,C.BLACK)[0],"F5","taking the enemy's last liberty rates just as high");
});

test("the survey stays silent in the opening, where there is no life-and-death question",()=>{
  const state=position({black:["E5"],white:["E3"]});
  assert.deepEqual(vitalPoints(state,C.BLACK),[],
    "a lone stone with four liberties is not a group at risk, and saying so would only "+
    "restate the contact terms the pattern priors already carry");
});

test("a group with two eyes is reported alive and a walled-in group is not",()=>{
  const live=E.survey(position({black:["A2","B1","B2","B3","B4","A4"]}),C.BLACK);
  assert.equal(live.groups.find(g=>g.color===C.BLACK).status,"alive");
  assert.equal(live.ownCritical,0,"nothing of ours is at risk");
  const dead=position({black:["C1","C2","C3","B3","A3"],
    white:["D1","D2","D3","D4","C4","B4","A4"]});
  const group=E.survey(dead,C.BLACK).groups.find(g=>g.color===C.BLACK);
  assert.equal(group.eyes,1,"a square-four eye space is a single eye");
  assert.notEqual(group.status,"alive");
});
