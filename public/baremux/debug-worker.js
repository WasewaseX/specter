/* TEMP DEBUG — isolates the bare-mux SharedWorker POST failure. Remove after diagnosis. */
self.onconnect = (e) => {
  const port = e.ports[0];
  port.onmessage = async (ev) => {
    const { label, url, opts, bodyKind } = ev.data;
    try {
      if (bodyKind === "blob") opts.body = new Blob(["hello-from-worker"]);
      else if (bodyKind === "stream") opts.body = new Response("hello-stream").body;
      else if (bodyKind === "string") opts.body = "hello-string";
      const r = await fetch(url, opts);
      const t = await r.text();
      port.postMessage(label + " -> OK " + r.status + " :: " + t.slice(0, 80));
    } catch (err) {
      port.postMessage(label + " -> ERR " + err.name + ": " + err.message);
    }
  };
};
