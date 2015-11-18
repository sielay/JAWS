'use strict';

/**
 * Action: Code Package: Lambda: Nodejs
 * - Accepts one function
 * - Collects and optimizes the function's Lambda code in a temp folder
 */

const JawsPlugin = require('../../JawsPlugin'),
    JawsError    = require('../../jaws-error'),
    JawsUtils    = require('../../utils/index'),
    JawsCli      = require('../../utils/cli'),
    BbPromise    = require('bluebird'),
    path         = require('path'),
    fs           = require('fs'),
    os           = require('os'),
    babelify     = require('babelify'),
    browserify   = require('browserify'),
    UglifyJS     = require('uglify-js'),
    wrench       = require('wrench'),
    Zip          = require('node-zip');

// Promisify fs module
BbPromise.promisifyAll(fs);

class CodePackageLambdaNodejs extends JawsPlugin {

  /**
   * Constructor
   */

  constructor(Jaws, config) {
    super(Jaws, config);
  }

  /**
   * Get Name
   */

  static getName() {
    return 'jaws.core.' + CodePackageLambdaNodejs.name;
  }

  /**
   * Register Plugin Actions
   */

  registerActions() {

    this.Jaws.addAction(this.codePackageLambdaNodejs.bind(this), {
      handler:       'codePackageLambdaNodejs',
      description:   'Deploys the code or endpoint of a function, or both'
    });

    return BbPromise.resolve();
  }

  /**
   * Function Deploy
   */

  codePackageLambdaNodejs(evt) {

    let _this = this;
    _this.evt = evt;

    // Load AWS Service Instances
    let awsConfig = {
      region:          _this.evt.deployRegion.region,
      accessKeyId:     _this.Jaws._awsAdminKeyId,
      secretAccessKey: _this.Jaws._awsAdminSecretKey,
    };
    _this.S3 = require('../../utils/aws/S3')(awsConfig);

    // Flow
    return BbPromise.try(function() {})
        .bind(_this)
        .then(_this._validateAndPrepare)
        .then(_this._createDistFolder)
        .then(_this._package)
  }

  /**
   * Validate And Prepare
   */

  _validateAndPrepare() {

    let _this = this,
        lambda;

    // Require function config
    let functionJson = require(_this.evt.currentFunction);

    // Skip Function if it does not have a lambda
    try {
      lambda = functionJson.cloudFormation.lambda;
    } catch(error) {
      return Promise.reject(new JawsError(_this.evt.currentFunction + 'does not have a lambda property'));
    }

    // Validate lambda attributes
    if (!lambda.Type
        || !lambda.Properties
        || !lambda.Properties.Runtime
        || !lambda.Properties.Handler) {
      return Promise.reject(new JawsError('Missing one of many required lambda attributes'));
    }

    // Add function path to functionJson
    functionJson.path = _this.evt.currentFunction;

    // Change function path to object
    _this.evt.currentFunction = functionJson;

    return BbPromise.resolve();
  }

  /**
   * Create Distribution Folder
   */

  _createDistFolder() {

    let _this = this;

    // Create dist folder
    let d             = new Date();
    _this.evt.distDir = path.join(os.tmpdir(), _this.evt.currentFunction.name + '@' + d.getTime());

    // Status
    JawsCli.log('Lambda Deployer:  Packaging "' + _this.evt.currentFunction.name + '"...');
    JawsCli.log('Lambda Deployer:  Saving in dist dir ' + _this.evt.distDir);

    JawsUtils.jawsDebug('copying', _this.Jaws._projectRootPath, 'to', _this.evt.distDir);

    // Copy entire test project to temp folder
    let excludePatterns = _this.evt.currentFunction.package.excludePatterns || [];
    wrench.copyDirSyncRecursive(
        _this.Jaws._projectRootPath,
        _this.evt.distDir,
        {
          exclude: function(name, prefix) {
            if (!excludePatterns.length) {
              return false;
            }

            let relPath = path.join(
                prefix.replace(_this.evt.distDir, ''), name);

            return excludePatterns.some(sRegex => {
              relPath = (relPath.charAt(0) == path.sep) ? relPath.substr(1) : relPath;

              let re          = new RegExp(sRegex),
                  matches     = re.exec(relPath),
                  willExclude = (matches && matches.length > 0);

              if (willExclude) {
                JawsCLI.log(`Lambda Deployer:  Excluding ${relPath}`);
              }

              return willExclude;
            });
          },
        }
    );

    JawsUtils.jawsDebug('Packaging stage & region:', _this.evt.stage, _this.evt.deployRegion);

    // Get ENV file from S3
    return _this.S3.sGetEnvFile(
        _this.evt.deployRegion.jawsBucket,
        _this.Jaws._projectJson.name,
        _this.evt.stage
    )
        .then(function(s3ObjData) {

          fs.writeFileSync(
              path.join(_this.evt.distDir,'.env'),
              s3ObjData.Body);

        });
  }

  /**
   * Package
   */

  _package() {

    let _this            = this,
        lambda           = _this.evt.currentFunction.cloudFormation.lambda,
        deferred         = false,
        targetZipPath    = path.join(_this.evt.distDir, 'package.zip'),
        optimizeSettings = _this.evt.currentFunction.package.optimize;

    if (optimizeSettings.builder) {

      deferred = _this._optimizeNodeJs()
          .then(optimizedCodeBuffer => {
            let envData         = fs.readFileSync(path.join(_this.evt.distDir, '.env')),
                handlerFileName = lambda.Function.Properties.Handler.split('.')[0],
                compressPaths   = [
                  // handlerFileName is the full path lambda file including dir rel to back
                  {fileName: handlerFileName + '.js', data: optimizedCodeBuffer},
                  {fileName: '.env', data: envData},
                ];

            compressPaths = compressPaths.concat(_this._generateIncludePaths());
            return compressPaths;
          });

    } else {

      // User chose not to optimize, zip up whatever is in back
      optimizeSettings.includePaths = ['.'];
      let compressPaths             = _this._generateIncludePaths();

      deferred = Promise.resolve(compressPaths);

    }

    return deferred
        .then(compressPaths => {
          return _this._compress(compressPaths, targetZipPath);
        })
        .then(zipFilePath => {
          return Promise.resolve({awsmFilePath: _this._lambdaAwsmPath, zipFilePath: zipFilePath});
        });
  }

  /**
   * Optimize
   */

  _optimize() {

    let _this   = this,
        lambda  = _this.evt.currentFunction.cloudFormation.lambda;

    if (!_this.evt.currentFunction.package.optimize
        || !_this.evt.currentFunction.package.optimize.builder) {
      return Promise.reject(new JawsError('Cant optimize for nodejs. lambda jaws.json does not have optimize.builder set'));
    }

    if (_this.evt.currentFunction.package.optimize.builder.toLowerCase() == 'browserify') {
      return _this._browserifyBundle();
    } else {
      return Promise.reject(new JawsError(`Unsupported builder ${builder}`));
    }
  }

  /**
   * Generate Include Paths
   */

  _generateIncludePaths() {

    let _this         = this,
        compressPaths = [],
        ignore        = ['.DS_Store'],
        stats,
        fullPath;

    _this._awsmJson.package.optimize.includePaths.forEach(p => {
      try {
        fullPath = path.resolve(path.join(_this._distDir, p));
        stats    = fs.lstatSync(fullPath);
      } catch (e) {
        console.error('Cant find includePath ', p, e);
        throw e;
      }

      if (stats.isFile()) {
        JawsUtils.jawsDebug('INCLUDING', fullPath);
        compressPaths.push({fileName: p, data: fs.readFileSync(fullPath)});
      } else if (stats.isDirectory()) {
        let dirname = path.basename(p);

        wrench
            .readdirSyncRecursive(fullPath)
            .forEach(file => {
              // Ignore certain files
              for (let i = 0; i < ignore.length; i++) {
                if (file.toLowerCase().indexOf(ignore[i]) > -1) return;
              }

              let filePath = [fullPath, file].join('/');
              if (fs.lstatSync(filePath).isFile()) {
                let pathInZip = path.join(dirname, file);
                JawsUtils.jawsDebug('INCLUDING', pathInZip);
                compressPaths.push({fileName: pathInZip, data: fs.readFileSync(filePath)});
              }
            });
      }
    });

    return compressPaths;
  }

  /**
   * Compress
   */

  _compress(compressPaths, targetZipPath) {
    let zip = new Zip();

    compressPaths.forEach(nc => {
      zip.file(nc.fileName, nc.data);
    });

    let zipBuffer = zip.generate({
      type:        'nodebuffer',
      compression: 'DEFLATE',
    });

    if (zipBuffer.length > 52428800) {
      Promise.reject(new JawsError(
          'Zip file is > the 50MB Lambda deploy limit (' + zipBuffer.length + ' bytes)',
          JawsError.errorCodes.ZIP_TOO_BIG)
      );
    }

    fs.writeFileSync(targetZipPath, zipBuffer);
    JawsCLI.log(`Lambda Deployer:  Compressed code written to ${targetZipPath}`);

    return Promise.resolve(targetZipPath);
  }


  /**
   * Browserify the code and return buffer of bundled code
   *
   * @returns {Promise.Buffer}
   * @private
   */

  _browserifyBundle() {

    let _this       = this;
    let uglyOptions = {
      mangle:   true, // @see http://lisperator.net/uglifyjs/compress
      compress: {},
    };
    let b           = browserify({
      basedir:          _this._distDir,
      entries:          [_this._awsmJson.cloudFormation.lambda.Function.Properties.Handler.split('.')[0] + '.js'],
      standalone:       'lambda',
      browserField:     false,  // Setup for node app (copy logic of --node in bin/args.js)
      builtins:         false,
      commondir:        false,
      ignoreMissing:    true,  // Do not fail on missing optional dependencies
      detectGlobals:    true,  // Default for bare in cli is true, but we don't care if its slower
      insertGlobalVars: {   // Handle process https://github.com/substack/node-browserify/issues/1277
        //__filename: insertGlobals.lets.__filename,
        //__dirname: insertGlobals.lets.__dirname,
        process: function() {
        },
      },
    });

    if (_this._awsmJson.package.optimize.babel) {
      b.transform(babelify);
    }

    if (_this._awsmJson.package.optimize.transform) {
      JawsUtils.jawsDebug('Adding transform', _this._awsmJson.package.optimize.transform);
      b.transform(_this._awsmJson.package.optimize.transform);
    }

    // optimize.exclude
    _this._awsmJson.package.optimize.exclude.forEach(file => {
      JawsUtils.jawsDebug('EXCLUDING', file);
      b.exclude(file);
    });

    // optimize.ignore
    _this._awsmJson.package.optimize.ignore.forEach(file => {
      JawsUtils.jawsDebug('IGNORING', file);
      b.ignore(file);
    });

    // Perform Bundle
    let bundledFilePath = path.join(_this._distDir, 'bundled.js');   // Save for auditing
    let minifiedFilePath = path.join(_this._distDir, 'minified.js'); // Save for auditing

    return new Promise(function(resolve, reject) {
      b.bundle(function(err, bundledBuf) {
        if (err) {
          console.error('Error running browserify bundle');
          reject(err);
        } else {
          fs.writeFileSync(bundledFilePath, bundledBuf);
          JawsCLI.log(`Lambda Deployer:  Bundled file written to ${bundledFilePath}`);

          if (_this._awsmJson.package.optimize.minify) {
            JawsUtils.jawsDebug('Minifying...');
            let result = UglifyJS.minify(bundledFilePath, uglyOptions);

            if (!result || !result.code) {
              reject(new JawsError('Problem uglifying code'));
            }

            fs.writeFileSync(minifiedFilePath, result.code);

            JawsCLI.log(`Lambda Deployer:  Minified file written to ${minifiedFilePath}`);
            resolve(result.code);
          } else {
            resolve(bundledBuf);
          }
        }
      });
    });
  }

}

module.exports = CodePackageLambdaNodejs;