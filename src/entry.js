// The deployed entry: the Worker in src/worker.js, plus the door motdang.net
// uses for readers signed in with LINE (src/site.js). A class of its own so the
// site reaches it only through its service binding; tests import worker.js.
import { WorkerEntrypoint } from "cloudflare:workers";
import worker from "./worker.js";
import * as site from "./site.js";

export class Site extends WorkerEntrypoint {
  status(uid) { return site.status(this.env, uid); }
  setHome(uid, lat, lng) { return site.setHome(this.env, uid, lat, lng); }
  clearHome(uid) { return site.clearHome(this.env, uid); }
  toSelf(uid, text) { return site.toSelf(this.env, uid, text); }
  remind(uid, key, at, text) { return site.remind(this.env, uid, key, at, text); }
  unremind(uid, key) { return site.unremind(this.env, uid, key); }
  weekly(uids, issue, text) { return site.weekly(this.env, uids, issue, text); }
  forget(uid) { return site.forget(this.env, uid); }
  usage() { return site.usage(this.env); }
}

export default worker;
