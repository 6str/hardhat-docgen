const fs = require('fs');
const path = require('path');
const webpack = require('webpack');
const { extendConfig } = require('hardhat/config');
const { HardhatPluginError } = require('hardhat/plugins');

const webpackConfig = require('./webpack.config.js');

const {
  TASK_COMPILE,
} = require('hardhat/builtin-tasks/task-names');

extendConfig(function (config, userConfig) {
  config.docgen = Object.assign(
    {
      path: './docgen',
      clear: false,
      runOnCompile: false,
    },
    userConfig.docgen
  );
});

const NAME = 'docgen';
const DESC = 'Generate NatSpec documentation automatically on compilation';

task(NAME, DESC, async function (args, hre) {
  const config = hre.config.docgen;

  const output = {};

  const outputDirectory = path.resolve(hre.config.paths.root, config.path);

  if (!outputDirectory.startsWith(hre.config.paths.root)) {
    throw new HardhatPluginError('resolved path must be inside of project directory');
  }

  if(outputDirectory === hre.config.paths.root) {
    throw new HardhatPluginError('resolved path must not be root directory');
  }

  if (config.clear) {
    fs.rmdirSync(outputDirectory, { recursive: true });
  }

  const contractNames = await hre.artifacts.getAllFullyQualifiedNames();

  for (let contractName of contractNames) {
    const [source, name] = contractName.split(':');

    const { abi, devdoc = {}, userdoc = {} } = (
      await hre.artifacts.getBuildInfo(contractName)
    ).output.contracts[source][name];

    const { title, author, details } = devdoc;
    const { notice } = userdoc;

    // derive external signatures from internal types

    const getSigType = function ({ type, components = [] }) {
      return type.replace('tuple', `(${ components.map(getSigType).join(',') })`);
    };

    const members = abi.reduce(function (acc, el) {
      // constructor, fallback, and receive do not have names
      let name = el.name || el.type;
      let inputs = el.inputs || [];
      acc[`${ name }(${ inputs.map(getSigType)})`] = el;
      return acc;
    }, {});

    // associate devdoc and userdoc comments with abi elements

    Object.keys(devdoc.events || {}).forEach(function (sig) {
      Object.assign(
        members[sig] || {},
        devdoc.events[sig]
      );
    });

    Object.keys(devdoc.stateVariables || {}).forEach(function (name) {
      Object.assign(
        members[`${ name }()`] || {},
        devdoc.stateVariables[name],
        { type: 'stateVariable' }
      );
    });

    Object.keys(devdoc.methods || {}).forEach(function (sig) {
      Object.assign(
        members[sig] || {},
        devdoc.methods[sig]
      );
    });

    Object.keys(userdoc.events || {}).forEach(function (sig) {
      Object.assign(
        members[sig] || {},
        userdoc.events[sig]
      );
    });

    Object.keys(userdoc.methods || {}).forEach(function (sig) {
      Object.assign(
        members[sig] || {},
        userdoc.methods[sig]
      );
    });

    const membersByType = Object.keys(members).reduce(function (acc, sig) {
      const { type } = members[sig];
      acc[type] = acc[type] || {};
      acc[type][sig] = members[sig];
      return acc;
    }, {});

    const constructor = members[Object.keys(members).find(k => k.startsWith('constructor('))];
    const { 'fallback()': fallback, 'receive()': receive } = members;

    output[contractName] = {
      // metadata
      source,
      name,
      // top-level docs
      title,
      author,
      details,
      notice,
      // special functions
      constructor,
      fallback,
      receive,
      // docs
      events: membersByType.event,
      stateVariables: membersByType.stateVariable,
      methods: membersByType.function,
    };
  }

  let error = await new Promise(function (resolve) {
    webpackConfig.output = { ...webpackConfig.output, path: outputDirectory };
    webpackConfig.plugins.push(
      new webpack.EnvironmentPlugin({
        'DOCGEN_DATA': output,
      })
    );

    webpack(
      webpackConfig,
      function (error, stats) {
        resolve(error || stats.compilation.errors[0]);
      }
    );
  });

  if (error) {
    throw new HardhatPluginError(error);
  }
});

task(TASK_COMPILE, async function (args, hre, runSuper) {
  for (let compiler of hre.config.solidity.compilers) {
    compiler.settings.outputSelection['*']['*'].push('devdoc');
    compiler.settings.outputSelection['*']['*'].push('userdoc');
  }

  await runSuper();

  if (hre.config.docgen.runOnCompile) {
    await hre.run(NAME);
  }
});
