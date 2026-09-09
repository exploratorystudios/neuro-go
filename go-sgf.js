(function(root,factory){
  const core=typeof module!=="undefined"&&module.exports?require("./go-core.js"):root.NcGoCore;
  const api=factory(core);
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  root.NcGoSgf=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(C){
  "use strict";

  // Only enough SGF to read a game record: the root properties and the main line of moves. Variations
  // are skipped rather than represented — these are server records of played games, so there are none,
  // and a parser that pretends otherwise is a parser with untested branches in it.
  const PROP=/([A-Z]+)((?:\[(?:\\.|[^\\\]])*\])+)/g;
  const VALUE=/\[((?:\\.|[^\\\]])*)\]/g;

  function unescape(text){return text.replace(/\\(.)/g,"$1")}

  // SGF point coordinates are lower-case letters from the top-left; `tt` (or an empty value) is a pass.
  function pointFromSgf(size,text){
    if(!text||text==="tt")return C.PASS;
    const c=text.charCodeAt(0)-97,r=text.charCodeAt(1)-97;
    if(!(c>=0&&c<size&&r>=0&&r<size))return null;
    return r*size+c;
  }
  function pointToSgf(size,point){
    if(point===C.PASS)return"";
    return String.fromCharCode(97+point%size)+String.fromCharCode(97+Math.floor(point/size));
  }

  // "Lukan (2230)" -> {name:"Lukan",rating:2230}. Server bots are prefixed with a colon.
  function parseName(raw){
    const text=String(raw||"").trim();
    const match=/^(.*?)\s*\((\d+)\)$/.exec(text);
    const name=(match?match[1]:text).trim();
    return{name,rating:match?Number(match[2]):null,bot:name.startsWith(":")};
  }

  // "W+8" -> {winner:WHITE,margin:8,scored:true}. A resignation or timeout is not a scored result;
  // these records simply carry no RE at all, which is the distinction the corpus is filtered on.
  function parseResult(raw){
    const text=String(raw||"").trim();
    if(!text)return null;
    const winner=text[0]==="B"?C.BLACK:text[0]==="W"?C.WHITE:null;
    if(winner===null)return null;
    const tail=text.slice(2);
    if(/^R/i.test(tail))return{winner,margin:null,scored:false,kind:"resign",text};
    if(/^T/i.test(tail))return{winner,margin:null,scored:false,kind:"time",text};
    const margin=Number(tail);
    if(!Number.isFinite(margin))return{winner,margin:null,scored:false,kind:"other",text};
    return{winner,margin,scored:true,kind:"score",text};
  }

  function parse(text){
    const root={};
    const moves=[];
    let size=19,seenRoot=false;
    PROP.lastIndex=0;
    let match;
    while((match=PROP.exec(text))){
      const key=match[1],values=[];
      VALUE.lastIndex=0;
      let v;
      while((v=VALUE.exec(match[2])))values.push(unescape(v[1]));
      if(key==="SZ")size=Number(values[0])||19;
      if(key==="B"||key==="W"){
        seenRoot=true;
        const point=pointFromSgf(size,values[0]);
        if(point===null)return null;
        moves.push({color:key==="B"?C.BLACK:C.WHITE,point});
      }else if(!seenRoot){
        root[key]=values.length>1?values:values[0];
      }
    }
    if(!moves.length)return null;
    return{
      size,
      komi:root.KM===undefined?7.5:Number(root.KM),
      rules:root.RU||null,
      black:parseName(root.PB),
      white:parseName(root.PW),
      result:parseResult(root.RE),
      date:root.DT||null,
      moves
    };
  }

  // Replay a parsed record into engine states. Records are trusted only as far as they verify: a move
  // the rules reject ends the replay, and the caller is told how far it got.
  function replay(game,{rules="simple-ko",onMove=null}={}){
    let state=C.createState(game.size,{komi:game.komi,rules,moveCap:game.size*game.size*3});
    let played=0;
    for(const move of game.moves){
      if(state.toPlay!==move.color)state={...state,toPlay:move.color};
      if(onMove&&onMove(state,move,played)===false)break;
      const next=C.play(state,move.point);
      if(!next)break;
      state=next;played++;
    }
    return{state,played,complete:played===game.moves.length};
  }

  return{parse,replay,parseName,parseResult,pointFromSgf,pointToSgf};
});
