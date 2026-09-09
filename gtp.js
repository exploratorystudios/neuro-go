"use strict";
const{spawn}=require("node:child_process");

// Minimal GTP client: one command in flight, responses terminated by a blank line.
class GtpEngine{
  constructor(command,args=[]){
    this.command=command;this.args=args;this.proc=null;this.buffer="";this.queue=[];
  }
  start(){
    this.proc=spawn(this.command,this.args,{stdio:["pipe","pipe","pipe"]});
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data",chunk=>{
      this.buffer+=chunk.replace(/\r/g,"");
      let index;
      while((index=this.buffer.indexOf("\n\n"))>=0){
        const raw=this.buffer.slice(0,index);this.buffer=this.buffer.slice(index+2);
        const pending=this.queue.shift();if(!pending)continue;
        const trimmed=raw.trim();
        if(trimmed.startsWith("?"))pending.reject(new Error(`${pending.command}: ${trimmed.slice(1).trim()}`));
        else pending.resolve(trimmed.replace(/^=\s*/,"").trim());
      }
    });
    this.proc.on("error",error=>{while(this.queue.length)this.queue.shift().reject(error)});
    return this;
  }
  send(command){
    return new Promise((resolve,reject)=>{
      this.queue.push({command,resolve,reject});
      this.proc.stdin.write(`${command}\n`);
    });
  }
  async close(){try{await this.send("quit")}catch{}this.proc?.kill()}
}

// Chinese rules + capture-all-dead + play-out-aftermath make GNU Go play the game to a state
// where Tromp-Taylor area scoring is valid: it will not pass while dead stones are still on the board.
const TROMP_TAYLOR_FLAGS=["--chinese-rules","--capture-all-dead","--play-out-aftermath"];

async function startGnuGo({binary="gnugo",level=10,size=9,komi=7.5,seed=1,extra=[]}={}){
  const engine=new GtpEngine(binary,["--mode","gtp","--level",String(level),"--seed",String(seed),...TROMP_TAYLOR_FLAGS,...extra]).start();
  const name=await engine.send("name"),version=await engine.send("version");
  await engine.send(`boardsize ${size}`);
  await engine.send("clear_board");
  await engine.send(`komi ${komi}`);
  return{engine,name:`${name} ${version}`,level};
}

module.exports={GtpEngine,startGnuGo,TROMP_TAYLOR_FLAGS};
