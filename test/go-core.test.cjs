"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const C=require("../go-core.js");
const P=require("../go-playout.js");
const{forcePlay}=require("../tools/gnugo-rating.cjs");

const at=(size,vertex)=>C.gtpToVertex(size,vertex);
function board(size,{black=[],white=[]}){
  const state=C.createState(size);
  for(const v of black)state.board[at(size,v)]=C.BLACK;
  for(const v of white)state.board[at(size,v)]=C.WHITE;
  state.history=[C.hashBoard(state.board,size)];
  return state;
}

test("coordinates round-trip and skip the letter I",()=>{
  assert.equal(C.vertexToGtp(9,at(9,"A9")),"A9");
  assert.equal(C.vertexToGtp(9,at(9,"J1")),"J1");
  assert.equal(C.vertexToGtp(19,at(19,"T19")),"T19");
  assert.equal(at(9,"I5"),null);
  assert.equal(C.gtpToVertex(9,"pass"),C.PASS);
});

test("a surrounded stone is captured and the point becomes empty",()=>{
  const state=board(9,{black:["E6","E4","D5"],white:["E5"]});
  const next=C.play(state,at(9,"F5"));
  assert.ok(next);
  assert.equal(next.board[at(9,"E5")],C.EMPTY);
  assert.equal(next.captures[C.BLACK],1);
});

test("suicide is illegal but a move that captures first is not",()=>{
  const filled=board(9,{white:["E6","E4","D5","F5"]});
  assert.equal(C.isLegal(filled,at(9,"E5")),false);
  const capturing=board(9,{black:["E6","E4","D5"],white:["E5"]});
  assert.equal(C.isLegal(capturing,at(9,"F5")),true);
});

test("simple ko forbids the immediate recapture and allows it one move later",()=>{
  const state=board(9,{black:["E6","E4","D5"],white:["E5","F6","F4","G5"]});
  const captured=C.play(state,at(9,"F5"));
  assert.equal(captured.ko,at(9,"E5"));
  assert.equal(C.isLegal(captured,at(9,"E5")),false);
  const elsewhere=C.play(C.play(captured,at(9,"A1")),at(9,"A9"));
  assert.equal(elsewhere.ko,C.PASS);
  assert.equal(C.isLegal(elsewhere,at(9,"E5")),true);
});

test("positional superko rejects a move that repeats a previous board",()=>{
  const state=board(9,{black:["E6","E4","D5"],white:["E5","F6","F4","G5"]});
  const probe=Int8Array.from(state.board);
  C.placeStone(probe,C.tables(9).neighbors,at(9,"F5"),C.BLACK);
  state.history.push(C.hashBoard(probe,9));
  assert.equal(C.isLegal(state,at(9,"F5")),false);
  const relaxed={...state,rules:"simple-ko"};
  assert.equal(C.isLegal(relaxed,at(9,"F5")),true);
  assert.ok(forcePlay(state,at(9,"F5")).forced,"the harness plays through a superko mismatch");
});

test("an eye needs all four diagonals on the edge and tolerates one in the centre",()=>{
  const{neighbors,diagonals}=C.tables(9);
  const centre=board(9,{black:["E6","E4","D5","F5","D6","F4"],white:["D4"]});
  assert.equal(C.isSimpleEye(centre.board,neighbors,diagonals,at(9,"E5"),C.BLACK),true);
  const twoHostile=board(9,{black:["E6","E4","D5","F5","D6"],white:["D4","F6"]});
  assert.equal(C.isSimpleEye(twoHostile.board,neighbors,diagonals,at(9,"E5"),C.BLACK),false);
  const edge=board(9,{black:["A8","B9"],white:["B8"]});
  assert.equal(C.isSimpleEye(edge.board,neighbors,diagonals,at(9,"A9"),C.BLACK),false);
});

test("area scoring gives an enclosed region to its only reaching colour",()=>{
  const walls={black:[],white:[]};
  for(let row=1;row<=9;row++){walls.black.push(`B${row}`);walls.white.push(`C${row}`)}
  const result=C.score({...board(9,walls),komi:0});
  assert.equal(result.black,18,"nine stones plus the nine A-file points behind the wall");
  assert.equal(result.white,63,"nine stones plus the fifty-four points east of the white wall");
  assert.equal(result.black+result.white,81,"a settled board leaves no neutral points");
  const dame=board(9,{black:["A9"],white:["A8"]});
  const split=C.score({...dame,komi:0});
  assert.equal(split.black+split.white,2,"points reaching both colours score for neither");
});

test("two passes end the game and playouts terminate on a settled board",()=>{
  const passed=C.play(C.play(C.createState(9),C.PASS),C.PASS);
  assert.equal(passed.gameOver,true);
  assert.equal(passed.result,"two-passes");
  const random=C.rng(11);
  for(let i=0;i<20;i++){
    const result=P.playout(C.createState(9),random);
    const neutral=81-result.black-result.white;
    // Playouts refuse self-atari, so a few dame can survive; they score for neither side, which is
    // what Tromp-Taylor already does with them. What matters is that almost nothing is left unsettled.
    assert.ok(neutral>=0&&neutral<=6,`expected a nearly settled board, ${neutral} points left neutral`);
  }
});
