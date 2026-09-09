(function(root,factory){
  const core=typeof module!=="undefined"&&module.exports?require("./go-core.js"):root.NcGoCore;
  const cognitive=typeof module!=="undefined"&&module.exports?require("./go-cognitive.js"):root.NcGoCognitive;
  const api=factory(core,cognitive);
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  root.NcGoRegions=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(C,G){
  "use strict";

  const{EMPTY,BLACK,WHITE,other,tables,libertiesAtLeast}=C;
  const clamp=(n,a=0,b=1)=>Math.max(a,Math.min(b,n));

  // Bouzy's dilation/erosion influence map. Stones radiate, then the radiation is eaten back from
  // the edges, leaving the areas each colour genuinely dominates.
  function influence(state,{dilations=5,erosions=21}={}){
    const size=state.size,{neighbors}=tables(size),n=size*size;
    let map=new Float64Array(n);
    for(let p=0;p<n;p++)map[p]=state.board[p]===BLACK?64:state.board[p]===WHITE?-64:0;
    for(let d=0;d<dilations;d++){
      const next=Float64Array.from(map);
      for(let p=0;p<n;p++){
        let positive=0,negative=0;
        for(const q of neighbors[p]){if(map[q]>0)positive++;else if(map[q]<0)negative++}
        if(map[p]>=0&&negative===0)next[p]+=positive;
        if(map[p]<=0&&positive===0)next[p]-=negative;
      }
      map=next;
    }
    for(let e=0;e<erosions;e++){
      const next=Float64Array.from(map);
      for(let p=0;p<n;p++){
        if(map[p]===0)continue;
        let against=0;
        for(const q of neighbors[p])if(map[p]>0?map[q]<=0:map[q]>=0)against++;
        if(map[p]>0)next[p]=Math.max(0,map[p]-against);
        else next[p]=Math.min(0,map[p]+against);
      }
      map=next;
    }
    return map;
  }

  // Regions partition the board: connected runs of the same influence sign. Every point belongs to
  // exactly one, so upward aggregation never double-counts a point.
  function segment(state,map){
    const size=state.size,{neighbors}=tables(size),n=size*size;
    const sign=p=>map[p]>0?1:map[p]<0?-1:0;
    const owner=new Int32Array(n).fill(-1),regions=[];
    for(let start=0;start<n;start++){
      if(owner[start]>=0)continue;
      const id=regions.length,s=sign(start),points=[];
      const stack=[start];owner[start]=id;
      while(stack.length){
        const p=stack.pop();points.push(p);
        for(const q of neighbors[p]){if(owner[q]<0&&sign(q)===s){owner[q]=id;stack.push(q)}}
      }
      regions.push({id,sign:s,points});
    }
    // Two regions are coupled when they touch on the board.
    const adjacency=regions.map(()=>new Set());
    for(let p=0;p<n;p++)for(const q of neighbors[p]){
      if(owner[p]!==owner[q]){adjacency[owner[p]].add(owner[q])}
    }
    return{regions,owner,adjacency:adjacency.map(set=>[...set])};
  }

  // Each region reports on its own patch only: what it holds, what is in danger, how hot it is.
  // Fraction of a region's points that touch a differently-signed region: where the two sides meet.
  function boundaryFractions(state,segmentation){
    const{neighbors}=tables(state.size),owner=segmentation.owner;
    const counts=segmentation.regions.map(()=>0);
    for(const region of segmentation.regions){
      let touching=0;
      for(const p of region.points){
        for(const q of neighbors[p]){
          if(owner[q]!==region.id&&segmentation.regions[owner[q]].sign!==region.sign){touching++;break}
        }
      }
      counts[region.id]=touching/Math.max(1,region.points.length);
    }
    return counts;
  }

  function analyze(state,segmentation,color){
    const size=state.size,{neighbors}=tables(size),board=state.board,enemy=other(color);
    const boundary=boundaryFractions(state,segmentation);
    return segmentation.regions.map(region=>{
      let own=0,foe=0,empty=0,ownAtRisk=0,foeAtRisk=0,minOwnLiberties=Infinity;
      for(const p of region.points){
        if(board[p]===EMPTY){empty++;continue}
        const liberties=libertiesAtLeast(board,neighbors,p,3);
        if(board[p]===color){
          own++;
          minOwnLiberties=Math.min(minOwnLiberties,liberties);
          if(liberties<=2)ownAtRisk++;
        }else if(board[p]===enemy){
          foe++;
          if(liberties<=2)foeAtRisk++;
        }
      }
      const stones=own+foe,area=region.points.length;
      // Heat is where the two sides actually meet, not where the board is merely empty. An earlier
      // version scored any neutral-influence region highly, which steered the search into open space
      // and away from contact fights — it measurably lost games.
      const urgency=clamp((ownAtRisk*1.4+foeAtRisk*1.1)/Math.max(1,stones||1));
      const temperature=clamp(.55*urgency+.6*boundary[region.id]+.25*clamp(stones/Math.max(1,area)));
      return{id:region.id,sign:region.sign,area,own,foe,empty,ownAtRisk,foeAtRisk,
        boundary:Number(boundary[region.id].toFixed(4)),
        minOwnLiberties:Number.isFinite(minOwnLiberties)?minOwnLiberties:4,
        urgency:Number(urgency.toFixed(4)),temperature:Number(temperature.toFixed(4)),
        base:Number(temperature.toFixed(4))};
    });
  }

  // Lateral pass: a fight next door raises the stakes here. Ko threats and escape routes are exactly
  // the couplings that make Go resist clean decomposition, so neighbours are not analysed in isolation.
  function communicate(reports,adjacency,{rounds=2,coupling=.35}={}){
    let current=reports.map(r=>({...r}));
    for(let round=0;round<rounds;round++){
      const next=current.map(r=>({...r}));
      for(const report of current){
        let loudest=0;
        for(const neighbour of adjacency[report.id])loudest=Math.max(loudest,current[neighbour].urgency);
        next[report.id].temperature=clamp(report.temperature+coupling*loudest*(1-report.temperature));
      }
      current=next;
    }
    return current;
  }

  // Upward: temperature becomes the share of search budget (prior mass) the region is granted.
  function allocate(reports,{sharpness=1.6,floor=.04}={}){
    const scores=reports.map(r=>Math.exp(r.temperature*sharpness));
    const total=scores.reduce((a,b)=>a+b,0)||1;
    const weights=scores.map(s=>s/total);
    const lifted=weights.map(w=>w+floor);
    const sum=lifted.reduce((a,b)=>a+b,0)||1;
    return lifted.map(w=>w/sum);
  }

  function survey(state,color,options={}){
    const map=influence(state,options);
    const segmentation=segment(state,map);
    const raw=analyze(state,segmentation,color);
    const reports=communicate(raw,segmentation.adjacency,options);
    const weights=allocate(reports,options);
    return{map,segmentation,reports,weights,owner:segmentation.owner};
  }

  return{influence,segment,analyze,communicate,allocate,survey};
});
