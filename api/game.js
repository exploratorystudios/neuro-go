"use strict";

const Session=require("../go-session.js");

const PLAYOUTS=Number(process.env.NCGO_PLAYOUTS||2000);
const DEAD_PLAYOUTS=Number(process.env.NCGO_DEAD_PLAYOUTS||600);

// Stateless by design: the client sends the whole move list, the server replays it and answers. Two
// requests never have to land on the same instance, which is what makes this deployable serverless.
function handle(body){
  const moves=Array.isArray(body.moves)?body.moves.map(Number):[];
  if(moves.length>400)throw new Error("Move list too long");
  if(moves.some(m=>!Number.isInteger(m)||m<-1||m>=Session.SIZE*Session.SIZE))throw new Error("Corrupt move list");
  const point=body.point===undefined||body.point===null?null:Number(body.point);
  return Session.advance(moves,point,{playouts:PLAYOUTS,deadPlayouts:DEAD_PLAYOUTS,seed:(Date.now()^0x9e3779b9)>>>0});
}

module.exports=(req,res)=>{
  if(req.method!=="POST"){res.statusCode=405;res.setHeader("Content-Type","application/json");return res.end(JSON.stringify({error:"Use POST"}))}
  let body=req.body;
  if(typeof body==="string"){try{body=JSON.parse(body||"{}")}catch(e){body=null}}
  if(!body||typeof body!=="object"){res.statusCode=400;res.setHeader("Content-Type","application/json");return res.end(JSON.stringify({error:"Invalid JSON"}))}
  try{
    const snapshot=handle(body);
    res.statusCode=200;res.setHeader("Content-Type","application/json");res.setHeader("Cache-Control","no-store");
    res.end(JSON.stringify(snapshot));
  }catch(error){
    res.statusCode=400;res.setHeader("Content-Type","application/json");res.end(JSON.stringify({error:error.message}));
  }
};
module.exports.handle=handle;
