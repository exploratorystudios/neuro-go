#!/usr/bin/env node
"use strict";
// A GTP engine wrapper, so the bot can be driven by any Go GUI (Sabaki, GoGui, Lizzie) or played
// against another engine with gogui-twogtp. Speaks GTP on stdin/stdout and nothing else — every
// diagnostic goes to stderr, because anything on stdout would corrupt the protocol.
//
//   node nc-go/engine.cjs --playouts 6000 --level 1
//
const C=require("./go-core.js");
const G=require("./go-cognitive.js");
const PL=require("./go-players.js");
const People=require("./go-personalities.js");

const argv=process.argv.slice(2);
const arg=(name,fallback)=>{const i=argv.indexOf(`--${name}`);return i<0?fallback:argv[i+1]};
const options={
  policy:arg("policy","puct"),
  playouts:Number(arg("playouts",6000)),
  fpuReduction:Number(arg("fpu",.2)),
  eyeMode:arg("eyes","root"),
  eyeWeight:Number(arg("eye-weight",1.1)),
  cPuct:Number(arg("cpuct",1.2)),
  raveBias:Number(arg("rave",.015)),
  ladders:arg("ladders","on")!=="off",
  rolloutLadders:arg("rollout-ladders","off")==="on",
  personality:arg("personality",null),
  styleWeight:Number(arg("style-weight",1)),
  bookWeight:Number(arg("book-weight",1)),
  playoutWeight:Number(arg("playout-weight",1))
};
if(options.personality&&!People.describe(options.personality)){
  process.stderr.write(`unknown personality "${options.personality}"; known: ${People.ids().join(", ")||"(none — run npm run go:style)"}\n`);
  process.exit(1);
}

let size=9,komi=7.5,state=null,mind=null,random=C.rng((Date.now()^0x9e3779b9)>>>0);
const stack=[];

function reset(){
  state=C.createState(size,{komi,moveCap:size*size*3});
  mind=null;stack.length=0;
}
reset();

function play(point){
  const next=C.play(state,point)||C.play({...state,rules:"simple-ko"},point);
  if(!next)return false;
  stack.push(state);
  state={...next,rules:state.rules};
  return true;
}

function person(){
  return People.resolve(options.personality,{styleWeight:options.styleWeight,
    bookWeight:options.bookWeight,playoutWeight:options.playoutWeight});
}
function genmove(color){
  state={...state,toPlay:color};
  if(!mind||mind.color!==color||mind.personality!==person())mind=G.createMind(color,(Math.random()*1e9)|0,person());
  const decision=PL.POLICIES[options.policy](state,random,{...options,mind,playouts:options.playouts});
  if(decision.mind)mind=decision.mind;
  let point=decision.point;
  if(point!==C.PASS&&!C.isLegal(state,point))point=C.PASS;
  play(point);
  return C.vertexToGtp(size,point);
}

const COMMANDS={
  protocol_version:()=>"2",
  name:()=>"Neuro-Cognitive Go",
  version:()=>`0.4 (cognitive-PUCT + eye layer${options.personality?` + ${options.personality}`:""})`,
  list_commands:()=>Object.keys(COMMANDS).join("\n"),
  known_command:a=>String(Object.prototype.hasOwnProperty.call(COMMANDS,a[0])),
  boardsize:a=>{const n=Number(a[0]);if(!Number.isInteger(n)||n<2||n>19)throw new Error("unacceptable size");size=n;reset();return""},
  clear_board:()=>{reset();return""},
  komi:a=>{komi=Number(a[0]);state={...state,komi};return""},
  play:a=>{
    const color=C.colorFrom(a[0]),point=C.gtpToVertex(size,a[1]);
    if(point===null)throw new Error("invalid coordinate");
    state={...state,toPlay:color};
    if(point==="resign")return"";
    if(!play(point))throw new Error("illegal move");
    return"";
  },
  genmove:a=>genmove(C.colorFrom(a[0])),
  undo:()=>{if(!stack.length)throw new Error("cannot undo");state=stack.pop();return""},
  showboard:()=>"\n"+C.render(state),
  final_score:()=>{
    const s=C.score(state);
    if(s.margin===0)return"0";
    return(s.margin>0?"B+":"W+")+Math.abs(s.margin).toFixed(1);
  },
  // GTP extensions. Anything a GUI does not know about it simply never sends, so these are free.
  nc_personality:a=>{
    if(!a.length)return options.personality||"none";
    const id=a[0].toLowerCase();
    if(id==="none"||id==="off"){options.personality=null;mind=null;return""}
    if(!People.describe(id))throw new Error(`unknown personality; known: ${People.ids().join(" ")}`);
    options.personality=id;mind=null;
    return"";
  },
  nc_personality_list:()=>People.list().map(p=>`${p.id} ${p.name} — ${p.label}`).join("\n")||"none",
  nc_style_weight:a=>{
    if(!a.length)return String(options.styleWeight);
    const value=Number(a[0]);
    if(!Number.isFinite(value)||value<0||value>4)throw new Error("style weight must be between 0 and 4");
    options.styleWeight=value;mind=null;return"";
  },
  quit:()=>{setTimeout(()=>process.exit(0),0);return""}
};

let buffer="";
process.stdin.setEncoding("utf8");
process.stdin.on("data",chunk=>{
  buffer+=chunk.replace(/\r/g,"");
  let index;
  while((index=buffer.indexOf("\n"))>=0){
    const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
    // GTP allows an optional numeric id before the command; it must be echoed back on the response.
    const tokens=line.replace(/#.*$/,"").trim().split(/\s+/).filter(Boolean);
    if(!tokens.length)continue;
    let id="";
    if(/^\d+$/.test(tokens[0]))id=tokens.shift();
    if(!tokens.length)continue;
    // GTP command names are conventionally hyphenated; the table is keyed by identifier, so accept both.
    const name=tokens.shift().toLowerCase().replace(/-/g,"_");
    const handler=COMMANDS[name];
    if(!handler){process.stdout.write(`?${id} unknown command\n\n`);continue}
    try{process.stdout.write(`=${id} ${handler(tokens)}\n\n`.replace(/ \n\n$/,"\n\n"))}
    catch(error){process.stdout.write(`?${id} ${error.message}\n\n`)}
  }
});
