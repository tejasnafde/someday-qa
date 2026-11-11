// Calls the QA helper on the runner (app/helper.mjs) from a flow:
//   - runScript:
//       file: helper.js
//       env:
//         CMD: otp            # the helper route, without the slash
//         ARG: some value     # optional
// The answer is in ${output.result}. A failed call fails the flow.
var port = typeof HELPER_PORT !== "undefined" && HELPER_PORT ? HELPER_PORT : "8765";
var arg = typeof ARG !== "undefined" && ARG ? "?arg=" + encodeURIComponent(ARG) : "";
var response = http.get("http://127.0.0.1:" + port + "/" + CMD + arg);
if (!response.ok) {
  throw new Error("helper " + CMD + " failed: HTTP " + response.status + " " + response.body);
}
output.result = response.body;
