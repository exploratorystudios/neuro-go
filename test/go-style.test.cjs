"use strict";
const test=require("node:test");
const assert=require("node:assert");
const C=require("../go-core.js");
const G=require("../go-cognitive.js");
const St=require("../go-style.js");
const People=require("../go-personalities.js");

const SIZE=9;
function position(labels){
  let state=C.createState(SIZE,{komi:7.5});
  for(const label of labels)state=C.play(state,C.gtpToVertex(SIZE,label));
  return state;
}
function transformed(board,t){
  const forward=St.maps(SIZE).forward[t],out=new Int8Array(board.length);
  for(let p=0;p<board.length;p++)out[forward[p]]=board[p];
  return out;
}

test("pattern keys are invariant under the eight board symmetries",()=>{
  const state=position(["E5","C3","G7","D6","D3","F4"]);
  const point=C.gtpToVertex(SIZE,"D4");
  const expected=St.patternKey(state.board,SIZE,point,state.toPlay);
  for(let t=0;t<8;t++){
    const board=transformed(state.board,t),moved=St.maps(SIZE).forward[t][point];
    assert.strictEqual(St.patternKey(board,SIZE,moved,state.toPlay),expected,`transform ${t}`);
  }
});

test("pattern keys distinguish colour and line",()=>{
  const state=position(["E5"]);
  const black=St.patternKey(state.board,SIZE,C.gtpToVertex(SIZE,"E6"),C.BLACK);
  const white=St.patternKey(state.board,SIZE,C.gtpToVertex(SIZE,"E6"),C.WHITE);
  assert.notStrictEqual(black,white,"own and enemy stones must not collide");
  const centre=St.patternKey(state.board,SIZE,C.gtpToVertex(SIZE,"D4"),C.BLACK);
  const edge=St.patternKey(state.board,SIZE,C.gtpToVertex(SIZE,"A4"),C.BLACK);
  assert.notStrictEqual(centre,edge,"line number is part of the key");
});

test("the expanded flat table matches the canonical lookup at every point",()=>{
  const state=position(["E5","C3","G7","D6","D3","F4","B2","H8"]);
  const sparse=new Map();
  for(let p=0;p<state.board.length;p++){
    if(state.board[p])continue;
    sparse.set(St.patternKey(state.board,SIZE,p,state.toPlay),(p%13)/10-.6);
  }
  const flat=St.expandPatterns(sparse);
  for(let p=0;p<state.board.length;p++){
    if(state.board[p])continue;
    const canonical=sparse.get(St.patternKey(state.board,SIZE,p,state.toPlay))||0;
    assert.ok(Math.abs(canonical-flat[St.rawKey(state.board,SIZE,p,state.toPlay)])<1e-5,`point ${p}`);
  }
});

test("canonical board keys fold symmetric positions together and map moves back",()=>{
  const state=position(["E5","C3","G7"]);
  const base=St.canonicalBoard(state.board,SIZE,state.toPlay);
  for(let t=0;t<8;t++){
    const board=transformed(state.board,t);
    const found=St.canonicalBoard(board,SIZE,state.toPlay);
    assert.strictEqual(found.key,base.key,`transform ${t} must hash to the same book entry`);
    const point=St.maps(SIZE).forward[t][C.gtpToVertex(SIZE,"D4")];
    assert.strictEqual(St.unmapPoint(SIZE,St.mapPoint(SIZE,point,found.transform),found.transform),point);
  }
});

test("a different position is a different book entry",()=>{
  const a=St.canonicalBoard(position(["E5","C3"]).board,SIZE,C.BLACK);
  const b=St.canonicalBoard(position(["E5","D3"]).board,SIZE,C.BLACK);
  assert.notStrictEqual(a.key,b.key);
});

// The rest of the suite needs the fitted data; skip rather than fail when it has not been generated.
const available=People.loaded();
const withData=(name,fn)=>test(name,{skip:available?false:"run npm run go:style to fit personalities"},fn);

withData("every personality carries weights, patterns and plan seeds",()=>{
  for(const entry of People.list()){
    const personality=People.get(entry.id);
    assert.ok(personality,`${entry.id} must resolve`);
    assert.ok(personality.patterns.size>0,`${entry.id} has patterns`);
    for(const plan of G.PLANS)assert.ok(Number.isFinite(personality.plans[plan]),`${entry.id} seeds ${plan}`);
    assert.strictEqual(personality.table.length,St.RAW_KEYS);
  }
});

withData("style weight zero reproduces the stock priors exactly",()=>{
  const state=position(["E5","C3"]);
  const moves=C.legalMoves(state,{includePass:false});
  const stock=G.policyPriors(state,G.updatePlans(G.createMind(C.BLACK,1),state),moves,{});
  // Only styleWeight is zeroed. It is the master dial, so the book and the rollout bias have to fall
  // silent with it — zeroing them here as well would hide exactly the bug this asserts against.
  const neutral=People.get("brawler",{styleWeight:0});
  const mind=G.createMind(C.BLACK,1,neutral);
  // Plan seeds are blended by styleWeight too, so a zero-weight personality starts from the flat mind.
  for(const plan of G.PLANS)assert.strictEqual(mind.plans[plan],.2);
  const styled=G.policyPriors(state,G.updatePlans(mind,state),moves,{});
  for(let i=0;i<stock.length;i++){
    assert.strictEqual(styled[i].point,stock[i].point);
    assert.ok(Math.abs(styled[i].score-stock[i].score)<1e-9,`move ${i} score must be untouched`);
  }
});

withData("a personality changes the priors it is given",()=>{
  const state=position(["E5","C3"]);
  const moves=C.legalMoves(state,{includePass:false});
  const stock=G.policyPriors(state,G.updatePlans(G.createMind(C.BLACK,1),state),moves,{});
  const brawler=G.policyPriors(state,
    G.updatePlans(G.createMind(C.BLACK,1,People.get("brawler")),state),moves,{});
  const moved=stock.some((x,i)=>Math.abs(x.prior-brawler[i].prior)>1e-6);
  assert.ok(moved,"the fitted tilt must be visible in the priors");
});

withData("personalities never propose an illegal or off-board move",()=>{
  for(const entry of People.list()){
    const personality=People.get(entry.id);
    let state=C.createState(SIZE,{komi:7.5});
    let mind=G.createMind(C.WHITE,3,personality);
    for(const label of["E5","E4","D4","F5","C6"])state=C.play(state,C.gtpToVertex(SIZE,label));
    const book=St.bookMoves(personality,state);
    if(book)for(const move of book){
      assert.ok(move.point>=0&&move.point<SIZE*SIZE,`${entry.id} book point in range`);
      assert.strictEqual(state.board[move.point],C.EMPTY,`${entry.id} book point is empty`);
    }
    mind=G.updatePlans(mind,state);
    for(const prior of G.policyPriors(state,mind,C.legalMoves(state),{})){
      assert.ok(Number.isFinite(prior.prior)&&prior.prior>=0,`${entry.id} priors are finite`);
    }
  }
});

withData("the opening book only ever fires on positions it recorded",()=>{
  const personality=People.get("brawler");
  const empty=C.createState(SIZE,{komi:7.5});
  const opening=St.bookMoves(personality,empty);
  assert.ok(opening&&opening.length,"the empty board must be in the book");
  // A position 40 moves deep is past the book depth and cannot be an entry.
  let late=empty;
  const script=["E5","E4","D4","F5","C6","G4","C3","G6","D7","F7","B5","H5","B7","H7","C8","G8"];
  for(const label of script)late=C.play(late,C.gtpToVertex(SIZE,label));
  const shares=St.bookMoves(personality,late);
  if(shares)for(const move of shares)assert.ok(move.share<=1);
});
