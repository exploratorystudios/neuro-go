#!/usr/bin/env node
"use strict";
// Play personalities against each other and against the stock engine, then report both things that
// matter: whether the style is visible in the moves, and what it costs in strength.
//
//   node tools/style-arena.cjs --a brawler --b none --games 20 --playouts 800
//   node tools/style-arena.cjs --all --games 12 --playouts 600
//
// Imitation and strength pull against each other, and a personality feature that is never measured
// against the engine it modifies is a feature that quietly makes the bot worse. Colours alternate
// every game so neither configuration keeps the first move, and both sides get the same playout
// budget so the comparison is of judgement rather than of time.
const C=require("../go-core.js");
const G=require("../go-cognitive.js");
const PL=require("../go-players.js");
const People=require("../go-personalities.js");
const Metrics=require("./lib/style-metrics.cjs");
const Ladder=require("../go-ladder.js");

const argv=process.argv.slice(2);
const arg=(name,fallback)=>{const i=argv.indexOf(`--${name}`);return i<0?fallback:argv[i+1]};
const flag=name=>argv.includes(`--${name}`);

const GAMES=Number(arg("games",20));
const PLAYOUTS=Number(arg("playouts",800));
// Per-side budgets, for comparing two configurations that do not cost the same per playout. Equal
// playouts flatters whichever side spends more work on each one; equal time is the honest question.
const PLAYOUTS_A=Number(arg("a-playouts",PLAYOUTS));
const PLAYOUTS_B=Number(arg("b-playouts",PLAYOUTS));
const SEED=Number(arg("seed",1));
const STYLE_WEIGHT=Number(arg("style-weight",1));
const PLAYOUT_WEIGHT=Number(arg("playout-weight",1));
const BOOK_WEIGHT=Number(arg("book-weight",1));
const SIZE=9,KOMI=7.5;
const LADDERS_A=arg("a-ladders","on")!=="off";
const LADDERS_B=arg("b-ladders","on")!=="off";
const ROLLOUT_A=arg("a-rollout-ladders","off")==="on";
const ROLLOUT_B=arg("b-rollout-ladders","off")==="on";

function config(id,ladders=true,rolloutLadders=false,playouts=PLAYOUTS){
  const suffix=(ladders?"":" (no ladders)")+(rolloutLadders?" +rollout":"");
  const tag=(ladders?"":"-nl")+(rolloutLadders?"-rl":"");
  if(!id||id==="none"||id==="stock")return{id:"stock"+tag,name:"stock"+suffix,personality:null,ladders,rolloutLadders,playouts};
  const spec=People.describe(id);
  if(!spec)throw new Error(`unknown personality "${id}"; known: ${People.ids().join(", ")||"(none)"}`);
  return{id:id+tag,name:spec.name+suffix,personality:id,ladders,rolloutLadders,playouts};
}

function playGame(black,white,seed){
  const budget={[black.id]:black.playouts,[white.id]:white.playouts};
  let state=C.createState(SIZE,{komi:KOMI,moveCap:SIZE*SIZE*3});
  const random=C.rng(seed>>>0);
  const options={styleWeight:STYLE_WEIGHT,bookWeight:BOOK_WEIGHT,playoutWeight:PLAYOUT_WEIGHT};
  const minds={
    [C.BLACK]:G.createMind(C.BLACK,seed,People.resolve(black.personality,options)),
    [C.WHITE]:G.createMind(C.WHITE,seed+1,People.resolve(white.personality,options))
  };
  const moves=[];
  const blunders={black:0,white:0};
  let guard=0;
  while(!state.gameOver&&guard++<SIZE*SIZE*3){
    const side=state.toPlay===C.BLACK?black:white;
    const decision=PL.puctPolicy(state,random,{...options,playouts:budget[side.id],mind:minds[state.toPlay],
      personality:side.personality,ladders:side.ladders,rolloutLadders:side.rolloutLadders,seed});
    minds[state.toPlay]=decision.mind;
    const mover=state.toPlay;
    const next=C.play(state,decision.point);
    if(!next)break;
    // A ladder blunder: the stone just played belongs to a group the opponent can now chase down and
    // capture outright. Counting these is the only direct evidence that the guard does its job —
    // a win rate cannot distinguish "stopped losing groups in ladders" from "got luckier".
    if(decision.point>=0&&Ladder.read(next.board,SIZE,decision.point,{attackerToMove:true}))
      blunders[mover===C.BLACK?"black":"white"]++;
    moves.push(decision.point);
    state=next;
  }
  const score=C.score(state);
  return{moves,margin:score.margin,winner:score.margin>0?C.BLACK:C.WHITE,length:moves.length,blunders};
}

function report(name,rows){
  const axes=Metrics.AXES.filter(a=>a!=="margin");
  const mean=axis=>rows.reduce((s,v)=>s+v[axis],0)/(rows.length||1);
  return Object.fromEntries(axes.map(a=>[a,mean(a)]));
}

function match(a,b,{games=GAMES,label=""}={}){
  const style={[a.id]:[],[b.id]:[]};
  const ladders={[a.id]:0,[b.id]:0};
  let winsA=0,winsB=0,totalLength=0;
  for(let i=0;i<games;i++){
    // Alternate who holds Black. The first move is worth real points on 9x9 even with komi.
    const aIsBlack=i%2===0;
    const black=aIsBlack?a:b,white=aIsBlack?b:a;
    const result=playGame(black,white,SEED+i*7919);
    const winner=result.winner===C.BLACK?black:white;
    if(winner.id===a.id)winsA++;else winsB++;
    totalLength+=result.length;
    ladders[black.id]+=result.blunders.black;
    ladders[white.id]+=result.blunders.white;
    const profiled=Metrics.profile(result.moves,{komi:KOMI,margin:result.margin});
    if(profiled.black)style[black.id].push(profiled.black);
    if(profiled.white)style[white.id].push(profiled.white);
    process.stderr.write(`\r  ${label}${i+1}/${games}  ${a.name} ${winsA} - ${winsB} ${b.name}   `);
  }
  process.stderr.write("\r".padEnd(72)+"\r");
  return{a,b,games,winsA,winsB,rateA:winsA/games,
    // Wilson-free but honest: the standard error of a proportion over this many games. With 20 games
    // it is about 11 points, which is the number to keep in mind before reading anything into a 12-8.
    stderr:Math.sqrt((winsA/games)*(1-winsA/games)/games),
    averageLength:totalLength/games,
    laddersA:ladders[a.id]/games,laddersB:ladders[b.id]/games,
    styleA:report(a.name,style[a.id]),styleB:report(b.name,style[b.id])};
}

function printMatch(result){
  const{a,b}=result;
  console.log(`\n${a.name} vs ${b.name} — ${result.winsA}-${result.winsB} over ${result.games} games ` +
    `(${(result.rateA*100).toFixed(0)}% ± ${(result.stderr*100).toFixed(0)}), avg ${result.averageLength.toFixed(0)} moves`);
  const axes=["contact","atari","capture","edge","center","openingCenter","tenuki","answer","selfAtari","liberties"];
  const short=name=>(name.length>9?name.slice(0,8)+"\u2026":name).padStart(10);
  console.log(`  ${"".padEnd(15)}${short(a.name)}${short(b.name)}${"delta".padStart(10)}`);
  const gap=result.laddersA-result.laddersB;
  console.log(`  ${"ladder blunders".padEnd(15)}${result.laddersA.toFixed(2).padStart(10)}` +
    `${result.laddersB.toFixed(2).padStart(10)}${((gap>=0?"+":"")+gap.toFixed(2)).padStart(10)}`);
  for(const axis of axes){
    const x=result.styleA[axis],y=result.styleB[axis];
    const delta=x-y;
    const mark=Math.abs(delta)>=(axis==="liberties"?.08:.02)?"  <=":"";
    console.log(`  ${axis.padEnd(15)}${x.toFixed(3).padStart(10)}${y.toFixed(3).padStart(10)}${(delta>=0?"+":"")+delta.toFixed(3)}`.padEnd(55)+mark);
  }
}

function main(){
  if(!People.loaded()){
    console.error("No personalities found. Run: npm run go:style");
    process.exit(1);
  }
  console.log(`arena: ${PLAYOUTS_A===PLAYOUTS_B?`${PLAYOUTS_A} playouts/move`:`${PLAYOUTS_A} vs ${PLAYOUTS_B} playouts/move`}, style weight ${STYLE_WEIGHT}, playout bias ${PLAYOUT_WEIGHT}`);
  if(flag("all")){
    const stock=config("none",LADDERS_B,ROLLOUT_B,PLAYOUTS_B),table=[];
    for(const id of People.ids()){
      const result=match(config(id,LADDERS_A,ROLLOUT_A,PLAYOUTS_A),stock,{label:`${id} `});
      printMatch(result);
      table.push(result);
    }
    console.log(`\nsummary vs stock (${GAMES} games each)`);
    for(const r of table){
      console.log(`  ${r.a.name.padEnd(13)} ${String(r.winsA).padStart(2)}-${String(r.winsB).padEnd(2)}  ` +
        `${(r.rateA*100).toFixed(0)}% ± ${(r.stderr*100).toFixed(0)}`);
    }
    return;
  }
  printMatch(match(config(arg("a","brawler"),LADDERS_A,ROLLOUT_A,PLAYOUTS_A),
    config(arg("b","none"),LADDERS_B,ROLLOUT_B,PLAYOUTS_B)));
}
main();
