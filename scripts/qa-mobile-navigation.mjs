import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function load(path, imports) {
  const module = {exports:{}};
  const code = ts.transpileModule(readFileSync(path,"utf8"), {compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
  runInNewContext(code, {exports:module.exports,require(name) {if(name in imports)return imports[name];throw Error(`Unexpected dependency: ${name}`);}, URL, Set, Date, Promise});
  return module.exports;
}
const nav=load("lib/navigation/mobile-navigation.ts",{});
for(const [href,expected] of [["/","/?month=2026-10&day=2026-10-31"],["/discover","/discover?date=2026-10-31"],["/map","/map"],["/saved","/saved?date=2026-10-31"]]) {
  assert.equal(nav.getMobileNavigationHref(href,"2026-10-31"),expected);
  assert.equal(nav.getMobileNavigationHref(href,null),href);
}
assert.equal(nav.getMobileNavigationHref("/saved","not-a-date"),"/saved");
assert.equal(nav.getMobileNavigationHref("/admin","2026-10-31"),"/admin");
for(const href of ["/","/discover?date=2026-10-31","/map?date=2026-10-31"]) assert.equal(nav.canPrefetchMobileNavigation(href),true);
for(const href of ["/saved","/saved?date=2026-10-31","/admin","/you"]) assert.equal(nav.canPrefetchMobileNavigation(href),false,"Private routes must not be prefetched across account changes.");

let configured=true, identity=null, privateReads=0, venueReads=0, active=0, peak=0, failVenue=false;
let library={savedEventIds:[],savedEvents:[],favoriteVenueIds:[],favoriteVenues:[]};
const SavedLibraryPanel="saved-library", SignInPromptCard="sign-in-prompt";
const jsx=(type,props)=>({type,props});
const page=load("app/(main)/saved/page.tsx",{
  "react/jsx-runtime":{jsx,jsxs:jsx},
  "@clerk/nextjs/server":{auth:async()=>({userId:identity})},
  "@/components/saved/saved-library-panel":{SavedLibraryPanel,SignInPromptCard},
  "@/lib/utils/env":{hasClerkEnv:()=>configured},
  "@/lib/events/public-date":{getPublicTodayKey:()=>"2026-10-31"},
  "@/lib/events/event-time":{resolveEventTimeDisplay:({time})=>({source:time?"event":"unknown",dayPeriod:time?"evening":"unknown",label:time||"Time not announced",startLabel:time})},
  "@/lib/convex/server":{createAuthenticatedConvexHttpClient:async()=>({query:async(name,args)=>{
    if(name==="users:getMyLibrary"){privateReads++;return library;}
    assert.equal(name,"venues:getPublicVenuePage");assert.equal(args.upcomingLimit,1);assert.equal(args.historyLimit,1);
    venueReads++;active++;peak=Math.max(peak,active);await Promise.resolve();active--;
    if(failVenue)throw Error("venue unavailable");
    return {upcomingEvents:[{_id:`next-${args.id}`,title:"Next event",date:"2026-11-01",time:"20:00",venue:"Venue",eventType:"live"}]};
  }})},
}).default;
const guest=await page({searchParams:Promise.resolve({date:"2026-10-31"})});
assert.equal(guest.props.children.type,SavedLibraryPanel,"Guests must receive the local Saved library without any private server read.");
assert.equal(guest.props.children.props.returnPath,"/saved?date=2026-10-31");assert.equal(privateReads,0);assert.equal(venueReads,0);
configured=false;
const unavailable=await page({});assert.equal(unavailable.props.children.type,SavedLibraryPanel);assert.equal(unavailable.props.children.props.authEnabled,false);assert.equal(privateReads,0);
configured=true;identity="real-account";
let signedIn=await page({});assert.equal(signedIn.props.children.type,SavedLibraryPanel);assert.equal(privateReads,1);assert.equal(venueReads,0,"No favourite venues must mean no city-wide upcoming scan.");
library={savedEventIds:["kept"],savedEvents:[{_id:"kept",title:"Kept",date:"2026-10-31",venue:"Venue",time:"21:00",eventType:"live"}],favoriteVenueIds:Array.from({length:9},(_,i)=>`venue-${i}`),favoriteVenues:[]};
signedIn=await page({});assert.equal(venueReads,9);assert.ok(peak<=4);assert.equal(signedIn.props.children.props.initialSavedEvents[0]._id,"kept");assert.equal(signedIn.props.children.props.upcomingEvents.length,10);
failVenue=true;signedIn=await page({});assert.equal(signedIn.props.children.props.initialSavedEvents[0]._id,"kept","A next-event lookup failure must not discard the authenticated saved library.");assert.ok(signedIn.props.children.props.initialError);
console.log("QA passed: mobile navigation date context, public-only intent prefetch, persistent guest Saved library, authenticated library, and bounded favourite reads.");
