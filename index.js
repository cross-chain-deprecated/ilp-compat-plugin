'use strict'

const uuid = require('uuid/v4')
const debug = require('debug')('ilp-compat-plugin')
const IlpPacket = require('ilp-packet')
const InterledgerRejectionError = require('./errors/InterledgerRejectionError')
const TransferHandlerAlreadyRegisteredError = require('./errors/TransferHandlerAlreadyRegisteredError')
const InvalidFieldsError = require('./errors/InvalidFieldsError')

const PASSTHROUGH_EVENTS = [
  'connect',
  'disconnect',
  'error',
  'info_change'
]

module.exports = (oldPlugin) => {
  if (typeof oldPlugin !== 'object') {
    throw new TypeError('not a plugin: not an object')
  }

  if (typeof oldPlugin.sendTransfer !== 'function') {
    throw new TypeError('not a plugin: no sendTransfer method')
  }

  if (oldPlugin.constructor.lpiVersion === 2) {
    return oldPlugin
  }

  class Plugin {
    constructor (oldPlugin) {
      this.oldPlugin = oldPlugin

      this.transfers = {}
      this._requestHandler = null

      const originalEmit = this.oldPlugin.emit
      this.oldPlugin.emit = (eventType, ...args) => {
        // Emit on both the original plugin and - for some event types - also
        // on the wrapper
        originalEmit.call(oldPlugin, eventType, ...args)

        if (PASSTHROUGH_EVENTS.indexOf(eventType) !== -1) {
          this.emit(eventType, ...args)
        }
      }

      this.oldPlugin.on('outgoing_fulfill', this._handleOutgoingFulfill.bind(this))
      this.oldPlugin.on('outgoing_reject', this._handleOutgoingReject.bind(this))
      this.oldPlugin.on('outgoing_cancel', this._handleOutgoingCancel.bind(this))
      this.oldPlugin.on('incoming_prepare', this._handleIncomingPrepare.bind(this))
    }

    connect () {
      return this.oldPlugin.connect()
    }

    disconnect () {
      return this.oldPlugin.disconnect()
    }

    isConnected () {
      return this.oldPlugin.isConnected()
    }

    getInfo () {
      return this.oldPlugin.getInfo()
    }

    async sendTransfer (transfer) {
      const id = uuid()

      const prefix = this.getInfo().prefix

      let to
      if (startsWith(prefix, transfer.destination)) {
        // If the destination starts with the ledger prefix, we deliver to the
        // local account as identified by the first segment after the prefix
        to = prefix + transfer.destination.substring(prefix.length).split('.')[0]
      } else {
        // Otherwise, we deliver to the default connector
        to = this.getInfo().connectors[0]
      }

      if (!to) {
        throw new Error('No valid destination: no connector and destination is not local')
      }

      const ilp = IlpPacket.serializeIlpPayment({
        account: transfer.destination,
        // amount is always zero to trigger forwarding behavior
        amount: '0',
        data: transfer.data.toString('base64')
      })

      const lpi1Transfer = {
        id,
        amount: transfer.amount,
        to,
        ledger: prefix,
        ilp,
        executionCondition: transfer.condition,
        expiresAt: transfer.expiry,
        custom: transfer.custom
      }

      return new Promise((resolve, reject) => {
        this.transfers[id] = { resolve, reject }

        transfer.sendTransfer(lpi1Transfer)
          .catch(reject)
      })
    }

    registerTransferHandler (handler) {
      if (this._transferHandler) {
        throw new TransferHandlerAlreadyRegisteredError('requestHandler is already registered')
      }

      if (typeof handler !== 'function') {
        throw new InvalidFieldsError('requestHandler must be a function')
      }

      this._transferHandler = handler
    }

    deregisterTransferHandler () {
      this._transferHandler = null
    }

    /**
     * Send a request.
     *
     * This functionality is considered deprecated and will likely be removed.
     *
     * @param {Message} request Request message
     * @return {Promise<Message>} Response message
     */
    sendRequest (request) {
      return this.oldPlugin.sendRequest(request)
    }

    registerRequestHandler (handler) {
      return this.oldPlugin.registerRequestHandler(handler)
    }

    deregisterRequestHandler () {
      return this.oldPlugin.deregisterRequestHandler()
    }

    _handleOutgoingFulfill (transfer, fulfillment, ilp) {
      if (!this.transfers[transfer.id]) {
        debug(`fulfillment for transfer ${transfer.id} ignored, unknown transfer id`)
        return
      }
      debug(`fulfillment for transfer ${transfer.id}`)

      const { resolve } = this.transfers[transfer.id]

      const { data } = IlpPacket.deserializeIlpFulfillment(ilp)
      resolve({
        fulfillment,
        data: Buffer.from(data, 'base64')
      })
    }

    _handleOutgoingReject (transfer, reason) {
      if (!this.transfers[transfer.id]) {
        debug(`rejection for transfer ${transfer.id} ignored, unknown transfer id`)
        return
      }
      debug(`rejection for transfer ${transfer.id}`)

      const { reject } = this.transfers[transfer.id]

      reject(reason)
    }

    _handleOutgoingCancel (transfer, reason) {
      if (!this.transfers[transfer.id]) {
        debug(`cancellation for transfer ${transfer.id} ignored, unknown transfer id`)
        return
      }
      debug(`cancellation for transfer ${transfer.id}`)

      const { reject } = this.transfers[transfer.id]

      reject(reason)
    }

    _handleIncomingPrepare (lpi1Transfer) {
      const { account, data } = IlpPacket.deserializeIlpPayment(Buffer.from(lpi1Transfer.ilp, 'base64'))
      debug(`incoming prepared transfer ${lpi1Transfer.id}`)

      const transfer = {
        amount: lpi1Transfer.amount,
        destination: account,
        data: Buffer.from(data, 'base64'),
        condition: lpi1Transfer.executionCondition,
        expiry: lpi1Transfer.expiresAt,
        custom: lpi1Transfer.custom
      }

      ;(async () => {
        if (!this._transferHandler) {
          debug(`no transfer handler, rejecting incoming transfer ${lpi1Transfer.id}`)
          // Reject incoming transfer due to lack of handler
          throw new InterledgerRejectionError({
            code: 'F00',
            message: 'No transfer handler registered'
          })
        }

        const { fulfillment, data } = await this._transferHandler(transfer)

        const ilp = IlpPacket.serializeIlpFulfillment({
          data: data.toString('base64')
        })

        this.oldPlugin.fulfillCondition(lpi1Transfer.id, fulfillment, ilp)
      })()
        .catch(err => {
          const errInfo = (typeof err === 'object' && err.stack) ? err.stack : err
          debug(`could not process incoming transfer ${lpi1Transfer.id}: ${errInfo}`)

          this.oldPlugin.rejectIncomingTransfer(lpi1Transfer, {

          })
        })
    }
  }

  Plugin.lpiVersion = 2

  return new Plugin(oldPlugin)
}

function startsWith (prefix, subject) {
  return subject.substring(0, prefix.length) === prefix
}