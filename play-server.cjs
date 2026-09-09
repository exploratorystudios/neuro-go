#!/usr/bin/env node
"use strict";

// Local development server. It serves `public/` and answers `/api/game` with exactly the handler
// Vercel runs in production, so what you play locally is what deploys.

const http=require("node:http");
const fs=require("node:fs");
const path=require("node:path");
const api=require("./api/game.js");

const argv=process.argv.slice(2);
const arg=(name,fallback)=>{const i=argv.indexOf(`--${name}`);return i<0?fallback:argv[i+1]};
const PORT=Number(arg("port",process.env.NCGO_PORT||4173));
const HOST=arg("host",process.env.NCGO_HOST||"0.0.0.0");
if(argv.includes("--playouts"))process.env.NCGO_PLAYOUTS=arg("playouts");
if(argv.includes("--dead-playouts"))process.env.NCGO_DEAD_PLAYOUTS=arg("dead-playouts");

const HTML=path.join(__dirname,"public","index.html");

function readBody(req){return new Promise((resolve,reject)=>{
  let body="";
  req.on("data",chunk=>{body+=chunk;if(body.length>20000)req.destroy(new Error("Request too large"))});
  req.on("end",()=>{try{resolve(body?JSON.parse(body):{})}catch(error){reject(new Error("Invalid JSON"))}});
  req.on("error",reject);
})}

const server=http.createServer(async(req,res)=>{
  try{
    if(req.method==="GET"&&(req.url==="/"||req.url==="/index.html")){
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});
      return res.end(fs.readFileSync(HTML));
    }
    if(req.url==="/api/game"){
      req.body=req.method==="POST"?await readBody(req):{};
      return api(req,res);
    }
    res.writeHead(404,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"Not found"}));
  }catch(error){
    res.writeHead(400,{"Content-Type":"application/json"});res.end(JSON.stringify({error:error.message}));
  }
});

server.listen(PORT,HOST,()=>{
  console.log(`Neuro-Cognitive Go listening on ${HOST}:${PORT}`);
  console.log(`Local:   http://127.0.0.1:${PORT}`);
  if(HOST==="0.0.0.0")console.log(`Network: open http://<this-computer-ip>:${PORT} from devices on your LAN`);
  console.log(`PUCT playouts per engine move: ${process.env.NCGO_PLAYOUTS||2000}`);
});

process.on("SIGINT",()=>server.close(()=>process.exit(0)));
