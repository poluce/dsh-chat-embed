/**
 * dsh-chat-embed — Host half.
 *
 * The whole feature lives in the Client half (`client.js`): the desktop
 * webview, the lease handshake, the panel UI. This half only has to exist so
 * the loader row named by `cordis.patch.yml` has a Node-side export to mount;
 * `dsh.client` in `package.json` publishes the browser half beside it.
 *
 * Keep this module inert. It must not import browser globals, and anything it
 * registers must be cleaned up through `ctx.effect` so uninstalling the bundle
 * leaves the Host process exactly as it was.
 */

export const name = 'dsh-chat-embed'

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  // Nothing to bind on the Host side yet.
  //
  // Extension point: if a later version needs to persist settings (chat URL,
  // user-agent mode), declare `export const Config` here and read it in the
  // Client half through its own `dsh.client` declaration. Secrets belong to
  // `ctx.credentials`, never to this plugin's configuration.
  void ctx
}
