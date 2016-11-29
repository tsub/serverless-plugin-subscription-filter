'use strict';

const _ = require('lodash');
const AWS = require('aws-sdk');

class ServerlessPluginSubscriptionFilter {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;

    this.provider = 'aws';
    AWS.config.update({
      region: this.serverless.service.provider.region
    });

    this.hooks = {
      'after:deploy:function:deploy': this.loopEvents.bind(this, this.register),
      'after:deploy:deploy': this.loopEvents.bind(this, this.register),
      'after:remove:remove': this.loopEvents.bind(this, this.remove),
    };
  }

  loopEvents(fn) {
    const serviceName = this.serverless.service.service;
    const stage = this.serverless.service.provider.stage;
    const functions = this.serverless.service.functions;

    _.each(functions, (fnDef, fnName) => {
      _.each(fnDef.events, (event) => {
        if (event.subscriptionFilter) {
          const functionName = `${serviceName}-${stage}-${fnName}`;
          fn.call(this, event.subscriptionFilter, functionName);
        }
      })
    });
  }

  register(setting, functionName) {
    this.serverless.cli.log(`Registering ${functionName} to ${setting.logGroupName} subscription filter...`);

    this.addPermission(functionName)
      .then((_data) => {
        return this.putSubscriptionFilter(setting, functionName);
      })
      .then((data) => {
      })
      .catch((err) => {
        console.log(err, err.stack);
      });
  }

  remove(setting, functionName) {
    this.serverless.cli.log(`Removing ${functionName} from ${setting.logGroupName} subscription filter...`);

    this.deleteSubscriptionFilter(setting, functionName)
      .then((data) => {
      })
      .catch((err) => {
        console.log(err, err.stack);
      });
  }

  putSubscriptionFilter(setting, functionName) {
    return new Promise((resolve, reject) => {
      this.checkAlreadyRegister(setting.logGroupName, setting.filterName)
        .then((isAlreadyRegister) => {
          if (isAlreadyRegister) {
            // Skip putSubscriptionFilter
            resolve();
          }

          return this.getFunctionArn(functionName);
        })
        .then((functionArn) => {
          const cloudWatchLogs = new AWS.CloudWatchLogs();
          const params = {
            destinationArn: functionArn,
            filterName: setting.filterName,
            filterPattern: setting.filterPattern,
            logGroupName: setting.logGroupName
          };

          return cloudWatchLogs.putSubscriptionFilter(params).promise();
        })
        .then((data) => {
          resolve(data);
        })
        .catch((err) => {
          reject(err);
        });
    });
  }

  deleteSubscriptionFilter(setting, functionName) {
    return new Promise((resolve, reject) => {
      this.checkAlreadyRegister(setting.logGroupName, setting.filterName)
        .then((isAlreadyRegister) => {
          if (!isAlreadyRegister) {
            // Skip deleteSubscriptionFilter
            resolve();
          }

          const cloudWatchLogs = new AWS.CloudWatchLogs();
          const params = {
            filterName: setting.filterName,
            logGroupName: setting.logGroupName
          };

          return cloudWatchLogs.deleteSubscriptionFilter(params).promise();
        })
        .then((data) => {
          resolve(data);
        })
        .catch((err) => {
          reject(err);
        });
    });
  }

  getFunctionArn(functionName) {
    return new Promise((resolve, reject) => {
      const lambda = new AWS.Lambda();
      const params = {
        FunctionName: functionName
      };

      lambda.getFunction(params).promise()
        .then((data) => {
          resolve(data.Configuration.FunctionArn);
        })
        .then((err) => {
          reject(err);
        });
    });
  }

  addPermission(functionName) {
    return new Promise((resolve, reject) => {
      this.checkAlreadyPermit(functionName)
        .then((isAlreadyPermit) => {
          if (isAlreadyPermit) {
            // Skip addPermission
            resolve();
          }

          const lambda = new AWS.Lambda();
          const params = {
            Action: 'lambda:InvokeFunction',
            FunctionName: functionName,
            Principal: 'logs.ap-northeast-1.amazonaws.com', // TODO: regionを動的に取得する
            StatementId: 'subscriptionFilter' // TODO: sidの決め打ちやめる
          };

          lambda.addPermission(params).promise()
            .then((data) => {
              resolve(data);
            })
            .catch((err) => {
              reject(err);
            });
      });
    });
  }

  checkAlreadyPermit(functionName) {
    return new Promise((resolve, reject) => {
      const lambda = new AWS.Lambda();
      const params = {
        FunctionName: functionName
      };

      lambda.getPolicy(params).promise()
        .then((data) => {
          const policy = JSON.parse(data.Policy);
          const sid = policy.Statement[0].Sid;

          if (sid == 'subscriptionFilter') { // TODO: sidの決め打ちやめる
            resolve(true);
          }

          resolve(false);
        })
        .catch((err) => {
          // aws-sdk throws ResourceNotFoundException when no policy.
          if (err.name === 'ResourceNotFoundException') {
            resolve(false);
          }

          reject(err);
        });
    });
  }

  checkAlreadyRegister(logGroupName, filterName) {
    return new Promise((resolve, reject) => {
      const cloudWatchLogs = new AWS.CloudWatchLogs();
      const params = {
        logGroupName,
        filterNamePrefix: filterName
      };

      cloudWatchLogs.describeSubscriptionFilters(params).promise()
        .then((data) => {
          if (data.subscriptionFilters.length > 0) {
            resolve(true);
          }

          resolve(false);
        })
        .catch((err) => {
          reject(err);
        });
    });
  }
}

module.exports = ServerlessPluginSubscriptionFilter;
