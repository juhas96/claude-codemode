export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({name:'codemode-test-probe',description:'Exercise the registered codemode tool without a model request'});
    return next(e);
  });
  on('command.run', {command:'codemode-test-probe'}, async ($, e) => {
    const result = await $.tool.call({tool:'mcp__codemode__execute',code:e.args});
    return {text: JSON.stringify(result)};
  });
}
