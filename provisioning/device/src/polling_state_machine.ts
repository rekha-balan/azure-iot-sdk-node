// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

'use strict';

import { EventEmitter } from 'events';
import { errors } from 'azure-iot-common';
import * as machina from 'machina';
import { PollingTransportHandlers, RegistrationRequest } from './interfaces';
import * as dbg from 'debug';
const debug = dbg('azure-device-provisioning:transport-fsm');

export class  PollingStateMachine extends EventEmitter {
  private _fsm: machina.Fsm;
  private _pollingTimer: any;
  private _transport: PollingTransportHandlers;
  private _currentOperationCallback: any;

  constructor(transport: PollingTransportHandlers) {
    super();

    this._transport = transport;

    this._fsm = new machina.Fsm({
      namespace: 'provisioning-transport',
      initialState: 'disconnected',
      states: {
        disconnected: {
          _onEnter: (err, body, result, callback) => {
            this._currentOperationCallback = null;
            if (callback) {
              callback(err, body, result);
            }
          },
          register: (request, requestBody, callback) => {
            this._fsm.transition('sendingRegistrationRequest', request, requestBody, callback);
          },
          endSession: (err, body, result, callback) => {
            /* Codes_SRS_NODE_PROVISIONING_TRANSPORT_STATE_MACHINE_18_025: [ If `endSession` is called while disconnected, it shall immediately call its `callback`. ] */
            // nothing to do.
            callback();
          }
        },
        idle: {
          _onEnter: (err, body, result, callback) => {
            callback(err, body, result);
          },
          endSession: (err, body, result, callback) => {
            this._fsm.transition('endingSession', err, body, result, callback);
          },
          register: (request, requestBody, callback) => {
            this._fsm.transition('sendingRegistrationRequest', request, requestBody, callback);
          },
        },
        sendingRegistrationRequest: {
          _onEnter: (request, requestBody, callback) => {
            /* Codes_SRS_NODE_PROVISIONING_TRANSPORT_STATE_MACHINE_18_012: [ `register` shall call `PollingTransportHandlers.registrationRequest`. ] */
            this._currentOperationCallback = callback;
            this._transport.registrationRequest(request, requestBody, (err, body, result, pollingInterval) => {
              // Check if the operation is still pending before transitioning.  We might be in a different state now and we don't want to mess that up.
              if (this._currentOperationCallback === callback) {
                this._fsm.transition('responseReceived', err, request, body, result, pollingInterval, callback);
              } else if (this._currentOperationCallback) {
                debug('Unexpected: received unexpected response for cancelled operaton');
              }
            });
          },
          endSession: (err, body, result, callback) => this._fsm.transition('endingSession', err, body, result, callback),
          /* Codes_SRS_NODE_PROVISIONING_TRANSPORT_STATE_MACHINE_18_024: [ If `register` is called while a different request is in progress, it shall fail with an `InvalidOperationError`. ] */
          register: (request, requestBody, callback) => callback(new errors.InvalidOperationError('another operation is in progress'))
        },
        responseReceived: {
          _onEnter: (err, request, body, result, pollingInterval, callback) => {
            if (err) {
              /* Codes_SRS_NODE_PROVISIONING_TRANSPORT_STATE_MACHINE_18_013: [ If `PollingTransportHandlers.registrationRequest` fails, `register` shall fail. ] */
              /* Codes_SRS_NODE_PROVISIONING_TRANSPORT_STATE_MACHINE_18_019: [ If `PollingTransportHandlers.queryOperationStatus` fails, `register` shall fail. ] */
              this._fsm.transition('responseError', err, body, result, callback);
            } else {
              debug('received response from service:' + JSON.stringify(body));
              switch (body.status.toLowerCase()) {
                case 'assigned': {
                  this._fsm.transition('responseComplete', body, result, callback);
                  break;
                }
                case 'assigning': {
                  /* Codes_SRS_NODE_PROVISIONING_TRANSPORT_STATE_MACHINE_18_015: [ If `PollingTransportHandlers.registrationRequest` succeeds with status==Assigning, it shall emit an 'operationStatus' event and begin polling for operation status requests. ] */
                  /* Codes_SRS_NODE_PROVISIONING_TRANSPORT_STATE_MACHINE_18_021: [ If `PollingTransportHandlers.queryOperationStatus` succeeds with status==Assigning, `register` shall emit an 'operationStatus' event and begin polling for operation status requests. ] */
                  this.emit('operationStatus', body);
                  this._fsm.transition('waitingToPoll', request, body.operationId, pollingInterval, callback);
                  break;
                }
                case 'failed': {
                  /* Codes_SRS_NODE_PROVISIONING_TRANSPORT_STATE_MACHINE_18_028: [ If `TransportHandlers.registrationRequest` succeeds with status==Failed, it shall fail with a `DeviceRegistrationFailedError` error ] */
                  /* Codes_SRS_NODE_PROVISIONING_TRANSPORT_STATE_MACHINE_18_029: [ If `TransportHandlers.queryOperationStatus` succeeds with status==Failed, it shall fail with a `DeviceRegistrationFailedError` error ] */
                  let err = new errors.DeviceRegistrationFailedError('registration failed');
                  (err as any).result = result;
                  (err as any).body = body;
                  this._fsm.transition('responseError', err, body, result, callback);
                  break;
                }
                default: {
                  /* Codes_SRS_NODE_PROVISIONING_TRANSPORT_STATE_MACHINE_18_016: [ If `PollingTransportHandlers.registrationRequest` succeeds returns with an unknown status, `register` shall fail with a `SyntaxError` and pass the response body and the protocol-specific result to the `callback`. ] */
                  /* Codes_SRS_NODE_PROVISIONING_TRANSPORT_STATE_MACHINE_18_022: [ If `PollingTransportHandlers.queryOperationStatus` succeeds with an unknown status, `register` shall fail with a `SyntaxError` and pass the response body and the protocol-specific result to the `callback`. ] */
                  let err = new SyntaxError('status is ' + body.status);
                  (err as any).result = result;
                  (err as any).body = body;
                  this._fsm.transition('responseError', err, body, result, callback);
                  break;
                }
              }
            }
          },
          '*': () => this._fsm.deferUntilTransition()
        },
        responseComplete: {
          _onEnter: (body, result, callback) => {
            this._currentOperationCallback = null;
            /* Codes_SRS_NODE_PROVISIONING_TRANSPORT_STATE_MACHINE_18_014: [ If `PollingTransportHandlers.registrationRequest` succeeds with status==Assigned, it shall emit an 'operationStatus' event and call `callback` with null, the response body, and the protocol-specific result. ] */
            /* Codes_SRS_NODE_PROVISIONING_TRANSPORT_STATE_MACHINE_18_020: [ If `PollingTransportHandlers.queryOperationStatus` succeeds with status==Assigned, `register` shall emit an 'operationStatus' event and complete and pass the body of the response and the protocol-spefic result to the `callback`. ] */
            this.emit('operationStatus', body);
            this._fsm.transition('idle', null, body, result, callback);
          },
          '*': () => this._fsm.deferUntilTransition()
        },
        responseError: {
          _onEnter: (err, body, result, callback) => {
            this._currentOperationCallback = null;
            this._fsm.transition('endingSession', err, body, result, callback);
          },
          '*': () => this._fsm.deferUntilTransition()
        },
        waitingToPoll: {
          _onEnter: (request, operationId, pollingInterval, callback) => {
            debug('waiting for ' + pollingInterval + ' ms');
            this._pollingTimer = setTimeout(() => {
              this._fsm.transition('polling', request, operationId, pollingInterval, callback);
            }, pollingInterval);
          },
          endSession: (err, body, result, callback) => {
            /* Codes_SRS_NODE_PROVISIONING_TRANSPORT_STATE_MACHINE_18_027: [ If a registration is in progress, `endSession` shall cause that registration to fail with an `OperationCancelledError`. ] */
            clearTimeout(this._pollingTimer);
            this._pollingTimer = null;
            this._fsm.transition('endingSession', err, body, result, callback);
          },
          register: (request, requestBody, callback) => callback(new errors.InvalidOperationError('another operation is in progress'))
        },
        polling: {
          _onEnter: (request, operationId, pollingInterval, callback) => {
            /* Codes_SRS_NODE_PROVISIONING_TRANSPORT_STATE_MACHINE_18_018: [ When the polling interval elapses, `register` shall call `PollingTransportHandlers.queryOperationStatus`. ] */
            this._transport.queryOperationStatus(request, operationId, (err, body, result, pollingInterval) => {
              // Check if the operation is still pending before transitioning.  We might be in a different state now and we don't want to mess that up.
              if (this._currentOperationCallback === callback) {
                this._fsm.transition('responseReceived', err, request, body, result, pollingInterval, callback);
              } else if (this._currentOperationCallback) {
                debug('Unexpected: received unexpected response for cancelled operation');
              }
            });
          },
          endSession: (err, body, result, callback) => this._fsm.transition('endingSession', err, body, result, callback),
          /* Codes_SRS_NODE_PROVISIONING_TRANSPORT_STATE_MACHINE_18_024: [ If `register` is called while a different request is in progress, it shall fail with an `InvalidOperationError`. ] */
          register: (request, requestBody, callback) => callback(new errors.InvalidOperationError('another operation is in progress'))
        },
        endingSession: {
          _onEnter: (err, body, result, callback) => {
            /* Codes_SRS_NODE_PROVISIONING_TRANSPORT_STATE_MACHINE_18_027: [ If a registration is in progress, `endSession` shall cause that registration to fail with an `OperationCancelledError`. ] */
            if (this._currentOperationCallback) {
              let _callback = this._currentOperationCallback;
              this._currentOperationCallback = null;
              _callback(new errors.OperationCancelledError(''));
            }
            this._transport.endSession((disconnectErr) => {
              if (disconnectErr) {
                debug('error received from transport during disconnection:' + disconnectErr.toString());
              }
              this._fsm.transition('disconnected', err || disconnectErr, body, result, callback);
            });
          },
          '*': () => this._fsm.deferUntilTransition()
        }
      }
    });

    this._fsm.on('transition',  (data) => {
      debug('completed transition from ' + data.fromState + ' to ' + data.toState);
    });
  }

  register(request: RegistrationRequest, requestBody: any, callback: (err?: Error, responseBody?: any, result?: any) => void): void {
    debug('register called for registrationId "' + request.registrationId + '"');
    this._fsm.handle('register', request, requestBody, callback);
  }

  endSession(callback: (err: Error) => void): void {
    debug('endSession called');
    this._fsm.handle('endSession', null, null, null, callback);
  }

}
