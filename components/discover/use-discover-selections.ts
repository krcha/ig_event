"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useUserLibrary } from "@/components/providers/user-library-provider";
import {
  acknowledgeDiscoverSaves, discoverLikedIds, discoverSessionStorageKey, mergeGuestDiscoverSessions, readDiscoverSessions, markDiscoverCompletion, pendingDiscoverSaveIds,
  recordDiscoverChoice, restartDiscoverScope, undoDiscoverChoice,
  type DiscoverChoice, type DiscoverDayChoices, type DiscoverScope, type DiscoverSessions,
} from "@/lib/discover/swipe-session";

export function useDiscoverSelections({isLoaded,isSignedIn,userId}: {isLoaded:boolean;isSignedIn:boolean;userId:string|null}, events: readonly { _id: string }[] = []) {
  const [sessions,setSessions] = useState<DiscoverSessions>({});
  const [hydrated,setHydrated] = useState(false);
  const [loadedKey,setLoadedKey] = useState<string|null>(null);
  const [saving,setSaving] = useState(false);
  const [failedIds,setFailedIds] = useState<string[]>([]);
  const [retry,setRetry] = useState(0);
  const memory = useRef<DiscoverSessions>({});
  const partitions = useRef(new Map<string,DiscoverSessions>());
  const unpersisted = useRef<DiscoverSessions>({});
  const attempted = useRef(new Set<string>());
  const savingRef = useRef(false);
  const storageKey = discoverSessionStorageKey(isSignedIn?userId:null);
  const activeKey = useRef(storageKey);
  const {isLibraryLoaded,savedEventIds,saveEvents,setSavedEvent,isEventPending} = useUserLibrary();

  useEffect(()=>{
    activeKey.current=storageKey; attempted.current.clear(); setFailedIds([]); unpersisted.current={};
    let next=partitions.current.get(storageKey) ?? {};
    try { next=readDiscoverSessions(localStorage.getItem(storageKey)); } catch { /* Preserve this identity's memory partition. */ }
    if(isSignedIn && userId){
      const guestKey=discoverSessionStorageKey(null);
      let guest=partitions.current.get(guestKey) ?? {};
      try { guest=readDiscoverSessions(localStorage.getItem(guestKey)); } catch { /* Guest memory can still be claimed once. */ }
      if(Object.keys(guest).length){
        next=mergeGuestDiscoverSessions(next,guest);
        try { localStorage.setItem(storageKey,JSON.stringify(next)); } catch { unpersisted.current=next; }
        // A guest selection is claimed once, by the first authenticated account.
        partitions.current.delete(guestKey);
        try { localStorage.removeItem(guestKey); } catch { /* Storage may be entirely unavailable. */ }
      }
    }
    memory.current=next; partitions.current.set(storageKey,next); setSessions(next); setLoadedKey(storageKey); setHydrated(true);
    const onStorage=(event:StorageEvent)=>{
      if(event.key!==storageKey && event.key!==null)return;
      const value={...readDiscoverSessions(event.newValue),...unpersisted.current};
      memory.current=value;partitions.current.set(storageKey,value);setSessions(value);
    };
    window.addEventListener("storage",onStorage);
    return ()=>window.removeEventListener("storage",onStorage);
  },[isLoaded,isSignedIn,storageKey,userId]);

  const commit=useCallback((date:string,update:(day:DiscoverDayChoices|undefined)=>DiscoverDayChoices)=>{
    const key=activeKey.current;
    let latest=memory.current;
    try{latest=readDiscoverSessions(localStorage.getItem(key));}catch{/* Use this account's memory if storage is blocked. */}
    latest={...latest,...unpersisted.current};
    const next={...latest,[date]:update(latest[date])};
    memory.current=next;partitions.current.set(key,next);setSessions(next);unpersisted.current[date]=next[date];
    try{localStorage.setItem(key,JSON.stringify(next));unpersisted.current={};}catch{/* Choices stay interactive in memory. */}
  },[]);
  const decide=useCallback((date:string,choice:DiscoverChoice,scope:DiscoverScope,scopeIds:readonly string[])=>{
    attempted.current.delete(choice.eventId);
    commit(date,day=>markDiscoverCompletion(recordDiscoverChoice(day,choice),scope,scopeIds));
  },[commit]);
  const complete=useCallback((date:string,scope:DiscoverScope)=>commit(date,day=>({...day,choices:day?.choices ?? [],completedScopes:[...new Set([...(day?.completedScopes ?? []),scope])]})),[commit]);

  useEffect(()=>{
    if(!hydrated || loadedKey!==storageKey || !isLibraryLoaded || savingRef.current || activeKey.current!==storageKey)return;
    const pending=pendingDiscoverSaveIds(sessions,new Set(),attempted.current);
    if(!pending.length)return;
    const key=storageKey; pending.forEach(id=>attempted.current.add(id));savingRef.current=true;setSaving(true);
    void saveEvents(pending, events).then(result=>{
      if(result.savedEventIds.length){
        let source=partitions.current.get(key) ?? {};
        try{source=readDiscoverSessions(localStorage.getItem(key));}catch{/* The originating account's memory is still isolated. */}
        if(activeKey.current===key)source={...source,...unpersisted.current};
        const next=acknowledgeDiscoverSaves(source,result.savedEventIds);
        partitions.current.set(key,next);
        try{localStorage.setItem(key,JSON.stringify(next));if(activeKey.current===key)unpersisted.current={};}catch{if(activeKey.current===key)unpersisted.current=next;}
        if(activeKey.current===key){memory.current=next;setSessions(next);}
      }
      if(activeKey.current!==key)return;
      setFailedIds(previous=>[...new Set([...previous.filter(id=>!result.savedEventIds.includes(id)),...result.failedEventIds])]);
    }).catch(()=>{if(activeKey.current===key)setFailedIds(previous=>[...new Set([...previous,...pending])]);})
      .finally(()=>{savingRef.current=false;setSaving(false);});
  },[events,hydrated,loadedKey,isSignedIn,isLibraryLoaded,retry,saveEvents,sessions,storageKey,userId,saving]);

  const retrySave=useCallback(()=>{attempted.current.clear();setFailedIds([]);setRetry(value=>value+1);},[]);
  const undo=useCallback((date:string,scope:DiscoverScope)=>commit(date,day=>undoDiscoverChoice(day,scope)),[commit]);
  const restart=useCallback((date:string,scope:DiscoverScope)=>commit(date,day=>restartDiscoverScope(day,scope)),[commit]);
  const removeLike=useCallback(async(date:string,eventId:string)=>{
    const key=activeKey.current;
    if(savedEventIds.has(eventId)){
      const result=await setSavedEvent(eventId,false);
      if(!result.success || activeKey.current!==key)return false;
    }
    commit(date,day=>({...day,choices:(day?.choices ?? []).map(choice=>choice.eventId===eventId?{...choice,decision:"skip"}:choice),completedScopes:day?.completedScopes ?? []}));
    attempted.current.delete(eventId);
    return true;
  },[commit,savedEventIds,setSavedEvent]);
  const acknowledged=new Set(Object.values(sessions).flatMap(day=>day.acknowledgedIds ?? []));
  const likedIds=new Set(discoverLikedIds(sessions));
  const ready=hydrated && loadedKey===storageKey && activeKey.current===storageKey;
  return {sessions:ready?sessions:{},hydrated:ready,saving,failedIds:ready?failedIds.filter(id=>likedIds.has(id)):[],retrySave,decide,complete,undo,restart,removeLike,isEventPending,
    areConfirmed:(ids:readonly string[])=>ids.every(id=>acknowledged.has(id)),
    areSaved:(ids:readonly string[])=>isLibraryLoaded && ids.every(id=>savedEventIds.has(id))};
}
