async function run($, e) {
  const result = await $.tool.call({tool:'mcp__codemode__execute',code:e.args});
  if (e.command === 'codemode-test-cancel-probe') await $.clock.sleep(6000);
  return {text: JSON.stringify(result)};
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({name:'codemode-test-probe',description:'Exercise the registered codemode tool without a model request'});
    await $.command.register({name:'codemode-test-cancel-probe',description:'Keep the session alive after a timed-out tool call'});
    return next(e);
  });
  on('command.run', {command:'codemode-test-probe'}, run);
  on('command.run', {command:'codemode-test-cancel-probe'}, run);
}
