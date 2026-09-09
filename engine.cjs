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

const argv=process.argv.slice(2);
const arg=(name,fallback)=>{const i=argv.indexOf(`--${name}`);return i<0?fallback:argv[i+1]};
const options={
  policy:arg("policy","puct"),
  playouts:Number(arg("playouts",6000)),
  fpuReduction:Number(arg("fpu",.2)),
  eyeMode:arg("eyes","root"),
  eyeWeight:Number(arg("eye-weight",1.1)),
  cPuct:Number(arg("cpuct",1.2)),
  raveBias:Number(arg("rave",.015))
};

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

function genmove(color){
  state={...state,toPlay:color};
  if(!mind)mind=G.createMind(color,(Math.random()*1e9)|0);
  if(mind.color!==color)mind=G.createMind(color,(Math.random()*1e9)|0);
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
  version:()=>"0.3 (cognitive-PUCT + eye layer)",
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
    const name=tokens.shift().toLowerCase();
    const handler=COMMANDS[name];
    if(!handler){process.stdout.write(`?${id} unknown command\n\n`);continue}
    try{process.stdout.write(`=${id} ${handler(tokens)}\n\n`.replace(/ \n\n$/,"\n\n"))}
    catch(error){process.stdout.write(`?${id} ${error.message}\n\n`)}
  }
});
