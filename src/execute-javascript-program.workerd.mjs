/** JSNode closures depend on Node's admitted loader and host capabilities.
 * A Worker may message an actor hosted on Node; it cannot impersonate that carrier. */
export async function executeJavascriptProgram(programme) {
  const error = new TypeError('JSNode programme requires execution by an actor hosted on Node');
  error.code = 'programme-carrier-unavailable';
  error.programme = programme;
  throw error;
}
