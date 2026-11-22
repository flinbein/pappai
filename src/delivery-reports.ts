export type DeliveryState = 'queued'|'delivered'|'rejected'|'unknown'|'timeout';
export type DeliveryNotice = {publication:string;node:string;status:DeliveryState};
type Waiting = {publication:string;node:string;complete:(status:DeliveryState)=>void};

export class DeliveryReports {
  private waiting = new Map<string,Waiting>();

  finish(itemId:string|undefined,status:DeliveryState) {
    if (!itemId) return;
    this.waiting.get(itemId)?.complete(status);
  }
  close() {
    for (const item of this.waiting.values()) item.complete('unknown');
  }
  begin(publication:string,mode:'status'|'track',timeout:number,visible:(node:string)=>boolean,
        notify?: (update:DeliveryNotice)=>void, signal?:AbortSignal) {
    const states = new Map<string,DeliveryState>();
    const items = new Set<string>();
    const snapshot = () => ({publication,deliveries:[...states].filter(([node])=>visible(node))
      .map(([node,status])=>({node,status}))});
    let done: (()=>void)|undefined;
    const settled = new Promise<void>(resolve=>{done=resolve;});
    let opened = false;
    let timer:NodeJS.Timeout|undefined;
    const expire = (status:DeliveryState) => {
      for (const id of items) this.finish(id,status);
    };
    const abort = ()=>expire('unknown');
    const check = () => {
      if (opened && !items.size) {
        clearTimeout(timer);
        signal?.removeEventListener('abort',abort);
        done?.();
      }
    };
    return {
      set:(node:string,status:DeliveryState)=>{
        if (visible(node)) states.set(node,status);
      },
      watch:(node:string,item:string)=>{
        if (!visible(node)) return;
        states.set(node,'queued');
        // During routing even status-only reports observe synchronous admission failures.
        items.add(item);
        this.waiting.set(item,{publication,node,complete:(status)=>{
          this.waiting.delete(item);
          items.delete(item);
          states.set(node,status);
          if (opened && mode === 'track' && notify && !signal?.aborted && visible(node))
            notify({publication,node,status});
          check();
        }});
      },
      discard:(item:string)=>{
        items.delete(item);
        this.waiting.delete(item);
      },
      result:()=>{
        opened=true;
        if (mode === 'status') {
          for (const item of items) this.waiting.delete(item);
          items.clear();
        } else if (items.size) {
          timer=setTimeout(()=>expire('timeout'),timeout);
          timer.unref();
          signal?.addEventListener('abort',abort,{once:true});
          if(signal?.aborted) abort();
        }
        check();
        return mode==='track' && !notify && items.size ? settled.then(snapshot) : snapshot();
      },
    };
  }
}
