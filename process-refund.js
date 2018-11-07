const BunqJSClient = require("@bunq-community/bunq-js-client").default;
const customStore = require("./custom_store")(__dirname + "/storage.json")
const BunqClient = new BunqJSClient(customStore)
const Fetch = require('node-fetch')
const RippledWsClient = require('rippled-ws-client')
const RippledWsClientSign = require('rippled-ws-client-sign')
const xrparrotStorage = require('../xrparrotStorage.json')

const ENCRYPTION_KEY = xrparrotStorage.ENCRYPTION_KEY
const API_KEY = xrparrotStorage.API_KEY
const DEVICE_NAME = xrparrotStorage.DEVICE_NAME
const ENVIRONMENT = xrparrotStorage.ENVIRONMENT
const PERMITTED_IPS = xrparrotStorage.PERMITTED_IPS

const API_TOKENS = xrparrotStorage.API_TOKENS
const API_ENDPOINTS = xrparrotStorage.API_ENDPOINTS
const XRPL_PAIR = xrparrotStorage.XRPL_PAIR
const XPRL_HOTWALLET = xrparrotStorage.XPRL_HOTWALLET
const FAMILY_SEED = xrparrotStorage.FAMILY_SEED

const setup = async () => {
    // load and refresh bunq client
    await BunqClient.run(API_KEY, PERMITTED_IPS, ENVIRONMENT, ENCRYPTION_KEY).catch(exception => {
        throw exception
    })

    // create/re-use a system installation
    await BunqClient.install().catch(error => {
        throw error.response.data
    })

    // create/re-use a device installation
    await BunqClient.registerDevice(DEVICE_NAME).catch(error => {
        throw error.response.data
    })

    // create/re-use a bunq session installation
    await BunqClient.registerSession().catch(error => {
        throw error.response.data
    })
}

const getMonetaryAccounts = async userid => {
    // get accounts
    const accounts = await BunqClient.api.monetaryAccount
        .list(userid)
        .catch(error => {
            throw error
        });

    return accounts
}

const getPayment = async (userid, monetaryaccountid, paymentId) => {
    const payment = await BunqClient.api.payment
        .get(userid, monetaryaccountid, paymentId)
        .catch(error => {
            throw error
        });

    return payment
}

const getUsers = () => BunqClient.getUsers(true)

const persist = async (orderResultDetails) => {
    if (typeof orderResultDetails.paymentId === 'undefined') return
    return Fetch(API_ENDPOINTS[orderResultDetails.mode] + 'payment/' + orderResultDetails.paymentId, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_TOKENS[orderResultDetails.mode] },
        body: JSON.stringify(orderResultDetails)
    })
        .then(res => res.json())
        .then(json => {
            console.log('<< BACKEND RESULTS >>', json)
        })
}

// run setup and get payments
setup().then(async setup => {
    let paymentDetails = {}

    const MODE = process.argv.length > 2 && process.argv[2].toUpperCase() === 'PROD' ? 'PROD' : 'TEST'
    paymentDetails.mode = MODE

    const users = await getUsers()
    const userType = Object.keys(users)[0] // UserCompany / UserPerson
    const accounts = await getMonetaryAccounts(users[userType].id);
    const activeAccounts = accounts.filter(account => {
        return (
            account.MonetaryAccountBank &&
            account.MonetaryAccountBank.status === "ACTIVE"
        )
    })

    return Fetch(API_ENDPOINTS[MODE] + 'payments/process-refund', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_TOKENS[MODE] } })
        .then(res => res.json())
        .then(async json => { 
            if (typeof json.data !== 'undefined' && Array.isArray(json.data) && json.data.length > 0) {
                console.log(`=====> PAYMENT\n`, json.data[0].id)
                console.log(`=====> DATA\n`, json.data[0])
                paymentDetails.paymentId = json.data[0].id
                paymentDetails.jsonData = json.data[0]
                
                const payment = await getPayment(users[userType].id, activeAccounts[0].MonetaryAccountBank.id, json.data[0].id)
                if (typeof payment.Payment === 'undefined') throw new Error('Invalid (live) payment details')
                return {
                    order: json.data[0],
                    livePayment: payment.Payment
                }
            } else {
                throw new Error('No orders to process')
            }
        })
        .then(data => {
            const amountValue = parseFloat(data.order.amount.value)
            if (data.order.amount.currency === 'EUR' && data.livePayment.id === data.order.id && data.livePayment.counterparty_alias.iban === data.order.counterparty_alias.iban && data.livePayment.amount.currency === data.order.amount.currency && parseFloat(data.livePayment.amount.value) === amountValue) {
                let fee = Math.floor(amountValue * 0.005 * 100) / 100
                if (fee < 1) fee = 1
                let amount = Math.floor((amountValue - fee) * 100) / 100

                if (amount < 0.25) throw new Error('Payment < 0.25 EUR will not be processed.')

                paymentDetails.amounts = {
                    input: amountValue,
                    fee: fee,
                    payout: amount
                }

                return {
                    eur: amount
                }
            } else {
                throw new Error('Payment details discrepancy')
            }
        })
        .then(async payment => {
            console.log(`=====> CHECKS COMPLETED, PAYMENT DETAILS\n`, payment)
            console.log(`=====> SEND REFUND ...`)
            paymentDetails.bankTransfer = {
                data: {
                    userId: users[userType].id,
                    monetaryAccountId: activeAccounts[0].MonetaryAccountBank.id,
                    description: 'REFUND XRParrot Payment ' + paymentDetails.jsonData.id,
                    amount: {
                        value: payment.eur.toFixed(2) + '',
                        currency: 'EUR'
                    },
                    counterpartyAlias: {
                        type: 'IBAN',
                        value: paymentDetails.jsonData.counterparty_alias.iban,
                        name: paymentDetails.jsonData.counterparty_alias.display_name
                    }
                },
                result: null
            }
            console.log(paymentDetails.bankTransfer)
            const paymentSent = await BunqClient.api.payment
                .post(
                    paymentDetails.bankTransfer.data.userId, // userId
                    paymentDetails.bankTransfer.data.monetaryAccountId, // monetaryAccountId
                    paymentDetails.bankTransfer.data.description, // description
                    paymentDetails.bankTransfer.data.amount, // amount
                    paymentDetails.bankTransfer.data.counterpartyAlias // counterpartyAlias
                    // options
                )
            console.log(paymentSent)
            paymentDetails.bankTransfer.result = paymentSent
            delete paymentDetails.jsonData
            return paymentSent
        })
        .then(async () => {
            // Todo: write results to backend
            paymentDetails.error = false
            paymentDetails.errorMessage = ''

            console.log('--'.repeat(30))
            console.log('Done')
            await persist(paymentDetails)
            process.exit()
        })
        .catch(async e => {
            // Todo: write results to backend
            paymentDetails.error = true
            paymentDetails.errorMessage = e.message

            console.log('--'.repeat(30))
            console.log('<NOT OK>', e.message)
            console.log(e)
            await persist(paymentDetails)
            process.exit()
        })
})
.catch(error => {
    console.log('<FATAL>', error.message)
    process.exit()
})