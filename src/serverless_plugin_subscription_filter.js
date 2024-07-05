const _ = require('lodash');
const AWS = require('aws-sdk');
const LIMIT_CLOUDWATCH_FILTER_COUNT = 2;

class ServerlessPluginSubscriptionFilter {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;

    this.provider = this.serverless.getProvider('aws');
    AWS.config.update({
      region: this.serverless.service.provider.region,
    });

    this.hooks = {
      'deploy:compileEvents': this.compileSubscriptionFilterEvents.bind(this),
    };
  }

  compileSubscriptionFilterEvents() {
    const stage = this.provider.getStage();
    const functions = this.serverless.service.getAllFunctions();
    const promises = [];

    this.preCheckResourceLimitExceeded(functions);

    functions.forEach((functionName) => {
      const functionObj = this.serverless.service.getFunction(functionName);
      functionObj.events.forEach((event, index) => {
        const subscriptionFilter = event.subscriptionFilter;

        if (this.validateSettings(subscriptionFilter)) {
          if (subscriptionFilter.stage !== stage) {
            // Skip compile
            return;
          }
          subscriptionFilter.stage = `${stage}-${Math.random().toString(36).substring(2, 7)}`; // `Math.random()` is used to avoid `Resource limit exceeded..` error
          promises.push(this.doCompile(subscriptionFilter, functionName, index));  // Pass index here
        }
      });
    });

    return Promise.all(promises);
  }

  validateSettings(setting) {
    if (!setting) {
      // Skip compile
      return false;
    }

    if (!setting.stage || typeof setting.stage !== 'string') {
      const errorMessage = [
        'You can\'t set stage properties of a subscriptionFilter event.',
        'stage propertiy is required.',
      ].join(' ');
      throw new this.serverless.classes.Error(errorMessage);
    }

    if (!setting.logGroupName || typeof setting.logGroupName !== 'string') {
      const errorMessage = [
        'You can\'t set logGroupName properties of a subscriptionFilter event.',
        'logGroupName propertiy is required.',
      ].join(' ');
      throw new this.serverless.classes.Error(errorMessage);
    }

    if (!setting.filterPattern || typeof setting.filterPattern !== 'string') {
      const errorMessage = [
        'You can\'t set filterPattern properties of a subscriptionFilter event.',
        'filterPattern propertiy is required.',
      ].join(' ');
      throw new this.serverless.classes.Error(errorMessage);
    }

    return true;
  }

  doCompile(setting, functionName, index) {
    return this.checkResourceLimitExceeded(setting.logGroupName, functionName)
      .then(_data => this.getLogGroupArn(setting.logGroupName))
      .then(logGroupArn => this.compilePermission(setting, functionName, logGroupArn, index))  // Pass index here
      .then((newPermissionObject) => {
        _.merge(
          this.serverless.service.provider.compiledCloudFormationTemplate.Resources,
          newPermissionObject,
        );

        return this.compileSubscriptionFilter(setting, functionName, index);  // Pass index here
      })
      .then((newSubscriptionFilterObject) => {
        _.merge(
          this.serverless.service.provider.compiledCloudFormationTemplate.Resources,
          newSubscriptionFilterObject,
        );
      })
      .catch((err) => {
        throw new this.serverless.classes.Error(err.message);
      });
  }

  preCheckResourceLimitExceeded(functions) {
    const logGroupNames = _.flatMap(functions, (functionName) => {
      const functionObj = this.serverless.service.getFunction(functionName);

      return functionObj.events;
    }).filter(event => event.subscriptionFilter)
      .map(event => event.subscriptionFilter.logGroupName);

    _.mapKeys(_.countBy(logGroupNames), (value, key) => {
      if (value > LIMIT_CLOUDWATCH_FILTER_COUNT) {
        const errorMessage = `
  Subscription filters of ${key} log group

  - Resource limit exceeded..

    You've hit a AWS resource limit:
    http://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/cloudwatch_limits_cwl.html

    Subscription filters: 1/log group. This limit cannot be changed.
        `;
        throw new this.serverless.classes.Error(errorMessage);
      }
    });
  }

  checkResourceLimitExceeded(logGroupName, functionName) {
    return new Promise((resolve, reject) => {
      const lambdaFunctionName = this.buildLambdaFunctionName(functionName);
      const promises = [
        ServerlessPluginSubscriptionFilter.getSubscriptionFilterDestinationArn(logGroupName),
        this.guessSubscriptionFilterDestinationArn(logGroupName, lambdaFunctionName),
      ];

      Promise.all(promises)
        .then((data) => {
          const subscriptionFilterDestinationArn = data[0];
          const guessedSubscriptionFilterDestinationArn = data[1];

          if (!subscriptionFilterDestinationArn) {
            return resolve();
          }

          if (subscriptionFilterDestinationArn !== guessedSubscriptionFilterDestinationArn) {
            const errorMessage = `
  Subscription filters of ${logGroupName} log group

  - Resource limit exceeded..

    You've hit a AWS resource limit:
    http://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/cloudwatch_limits_cwl.html

    Subscription filters: 1/log group. This limit cannot be changed.
            `;

            return reject(new this.serverless.classes.Error(errorMessage));
          }

          return resolve();
        })
        .catch((err) => {
          reject(err);
        });
    });
  }

  compileSubscriptionFilter(setting, functionName, index) {
    return new Promise((resolve, _reject) => {
      const lambdaLogicalId = this.provider.naming.getLambdaLogicalId(functionName);
      const lambdaPermissionLogicalId = this.getLambdaPermissionLogicalId(functionName, setting.logGroupName, index);  // Pass index here
      const filterPattern = ServerlessPluginSubscriptionFilter.escapeDoubleQuote(setting.filterPattern);
      const logGroupName = setting.logGroupName;
      const subscriptionFilterTemplate = `
        {
          "Type" : "AWS::Logs::SubscriptionFilter",
          "Properties" : {
            "DestinationArn" : { "Fn::GetAtt": ["${lambdaLogicalId}", "Arn"] },
            "FilterPattern" : "${filterPattern}",
            "FilterName": "${lambdaPermissionLogicalId}-${setting.stage}",
            "LogGroupName" : "${logGroupName}"
          },
          "DependsOn": "${lambdaPermissionLogicalId}"
        }
      `;
      const subscriptionFilterLogicalId = this.getSubscriptionFilterLogicalId(functionName, setting.logGroupName, index);  // Pass index here
      const newSubscriptionFilterObject = {
        [subscriptionFilterLogicalId]: JSON.parse(subscriptionFilterTemplate),
      };

      resolve(newSubscriptionFilterObject);
    });
  }

  compilePermission(setting, functionName, logGroupArn, index) {
    return new Promise((resolve, _reject) => {
      const lambdaLogicalId = this.provider.naming.getLambdaLogicalId(functionName);
      const region = this.provider.getRegion();
      const permissionTemplate = `
        {
          "Type": "AWS::Lambda::Permission",
          "Properties": {
            "FunctionName": { "Fn::GetAtt": ["${lambdaLogicalId}", "Arn"] },
            "Action": "lambda:InvokeFunction",
            "Principal": "logs.${region}.amazonaws.com",
            "SourceArn": "${logGroupArn}"
          }
        }
      `;
      const lambdaPermissionLogicalId = this.getLambdaPermissionLogicalId(functionName, setting.logGroupName, index);  // Pass index here
      const newPermissionObject = {
        [lambdaPermissionLogicalId]: JSON.parse(permissionTemplate),
      };

      resolve(newPermissionObject);
    });
  }

  getLogGroupArn(logGroupName, nextToken = null) {
    return new Promise((resolve, reject) => {
      const cloudWatchLogs = new AWS.CloudWatchLogs();
      const params = {
        logGroupNamePrefix: logGroupName,
        nextToken,
      };

      cloudWatchLogs.describeLogGroups(params).promise()
        .then((data) => {
          const logGroups = data.logGroups;
          if (logGroups.length === 0) {
            return reject(new Error('LogGroup not found'));
          }

          const logGroup = _.find(logGroups, { logGroupName });
          if (!logGroup) {
            return this.getLogGroupArn(logGroupName, data.nextToken);
          }

          return resolve(logGroup.arn);
        })
        .catch((err) => {
          reject(err);
        });
    });
  }

  getSubscriptionFilterLogicalId(functionName, logGroupName, index) {
    const normalizedFunctionName = this.provider.naming.getNormalizedFunctionName(functionName);
    const normalizedLogGroupName = this.provider.naming.normalizeNameToAlphaNumericOnly(logGroupName);

    return `${normalizedFunctionName}SubscriptionFilter${normalizedLogGroupName}${index}`;  // Append index
  }

  getLambdaPermissionLogicalId(functionName, logGroupName, index) {
    const normalizedFunctionName = this.provider.naming.getNormalizedFunctionName(functionName);
    const normalizedLogGroupName = this.provider.naming.normalizeNameToAlphaNumericOnly(logGroupName);

    return `${normalizedFunctionName}LambdaPermission${normalizedLogGroupName}${index}`;  // Append index
  }

  static escapeDoubleQuote(str) {
    return str.replace(/"/g, '\\"');
  }

  buildLambdaFunctionName(functionName) {
    const stackName = this.provider.naming.getStackName();
    return `${stackName}-${functionName}`;
  }

  static getSubscriptionFilterDestinationArn(logGroupName) {
    const cloudWatchLogs = new AWS.CloudWatchLogs();
    const params = {
      logGroupName,
    };

    return cloudWatchLogs.describeSubscriptionFilters(params).promise()
      .then((data) => {
        const subscriptionFilters = data.subscriptionFilters;
        if (subscriptionFilters.length === 0) {
          return null;
        }

        const subscriptionFilter = _.head(subscriptionFilters);

        return subscriptionFilter.destinationArn;
      });
  }

  guessSubscriptionFilterDestinationArn(logGroupName, lambdaFunctionName) {
    return new Promise((resolve, _reject) => {
      const cloudFormation = new AWS.CloudFormation();
      const stackName = this.provider.naming.getStackName();
      const stackParams = {
        StackName: stackName,
      };

      cloudFormation.describeStacks(stackParams).promise()
        .then((data) => {
          const outputs = _.flatMap(data.Stacks, (stack) => stack.Outputs);
          const output = _.find(outputs, { OutputKey: `${logGroupName}${lambdaFunctionName}` });
          if (!output) {
            return resolve(null);
          }

          return resolve(output.OutputValue);
        })
        .catch((err) => {
          if (err.code === 'ValidationError' && err.message.includes('does not exist')) {
            console.log(`Stack ${stackName} does not exist.`);
            return resolve(null);
          }
          return _reject(err); // Handle other errors appropriately
        });
    });
  }
}

module.exports = ServerlessPluginSubscriptionFilter;