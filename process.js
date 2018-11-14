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

    return Fetch(API_ENDPOINTS[MODE] + 'payments/process-payout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_TOKENS[MODE] } })
        .then(res => res.json())
        .then(async json => { 
            if (typeof json.data !== 'undefined' && Array.isArray(json.data) && json.data.length > 0) {
                if (typeof json.data[0]._order !== 'undefined' && json.data[0]._order && typeof json.data[0]._order.details !== 'undefined') {
                    console.log(`=====> PAYMENT\n`, json.data[0].id)
                    console.log(`=====> SESSION & DESTINATION\n`, json.data[0]._order.details)
                    console.log(`=====> COUNTERPARTY\n`, json.data[0].counterparty_alias)
                    console.log(`=====> AMOUNT\n`, json.data[0].amount)
                    console.log(`=====> AMOUNT @ BANK: check...`)

                    paymentDetails.paymentId = json.data[0].id
                    paymentDetails.order = json.data[0]._order
                    
                    const payment = await getPayment(users[userType].id, activeAccounts[0].MonetaryAccountBank.id, json.data[0].id)
                    if (typeof payment.Payment === 'undefined') throw new Error('Invalid (live) payment details')
                    return {
                        order: json.data[0],
                        livePayment: payment.Payment
                    }
                } else {
                    throw new Error('Order missing destination details')
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
                    eur: amount,
                    to: data.order._order.details.address,
                    tag: parseInt(data.order._order.details.tag) || null,
                    memo: data.order._order.details.description
                }
            } else {
                throw new Error('Payment details discrepancy')
            }
            return
        })
        .then(async payment => {
            console.log(`=====> CHECKS COMPLETED, PAYMENT DETAILS\n`, payment)
            console.log(`=====> Setting up connection to rippled...`)
            const connection = await new RippledWsClient('wss://rippled.xrptipbot.com')
            const offers = await connection.send({
                command: 'book_offers',
                limit: 10,
                taker_pays: XRPL_PAIR,
                taker_gets: { currency: 'XRP' }
            })
            const offerRates = offers.offers.map(o => {
                return Math.floor(parseFloat(o.quality) * 1000000 * 1000) / 1000
            })
            
            paymentDetails.xrplRates = offerRates

            return { payment, connection, offerRates }
        })
        .then(async data => {
            console.log(`=====> Connected, Sign & Submit transaction`)
            const tx = {
                TransactionType: 'Payment',
                Flags: 131072,
                Account: XPRL_HOTWALLET,
                Destination: XPRL_HOTWALLET,
                Fee: '20',
                // Destination: data.payment.to,
                // DestinationTag: data.payment.tag,
                Amount: Math.floor((data.payment.eur / data.offerRates[0]) * 1000000),
                SendMin: { ...XRPL_PAIR, value: data.payment.eur + '' },
                SendMax: { ...XRPL_PAIR, value: data.payment.eur + '' },
                Memos: [
                    {
                        Memo: {
                            MemoType: Buffer.from('Service', 'utf8').toString('hex').toUpperCase(),
                            MemoData: Buffer.from('XRParrot', 'utf8').toString('hex').toUpperCase()
                        }
                    },
                    {
                        Memo: {
                            MemoType: Buffer.from('PaymentId', 'utf8').toString('hex').toUpperCase(),
                            MemoData: Buffer.from(data.payment.memo, 'utf8').toString('hex').toUpperCase()
                        }
                    },
                    {
                        Memo: {
                            MemoType: Buffer.from('BankTransferEUR', 'utf8').toString('hex').toUpperCase(),
                            MemoData: Buffer.from(paymentDetails.amounts.input.toFixed(2) + '', 'utf8').toString('hex').toUpperCase()
                        }
                    },
                    {
                        Memo: {
                            MemoType: Buffer.from('XRParrotFeeEUR', 'utf8').toString('hex').toUpperCase(),
                            MemoData: Buffer.from(paymentDetails.amounts.fee.toFixed(2) + '', 'utf8').toString('hex').toUpperCase()
                        }
                    },
                    {
                        Memo: {
                            MemoType: Buffer.from('PayoutEUR', 'utf8').toString('hex').toUpperCase(),
                            MemoData: Buffer.from(data.payment.eur.toFixed(2) + '', 'utf8').toString('hex').toUpperCase()
                        }
                    }
                ]
            }
            console.log(tx)
            paymentDetails.xrplTx = tx
              
            const signAndSubmit = await new RippledWsClientSign(tx, FAMILY_SEED, data.connection)

            return {
                tx: signAndSubmit,
                xrpDestination: {
                    to: data.payment.to,
                    tag: data.payment.tag
                },
                connection: data.connection
            }
        })
        .then(async data => {
            console.log(data.tx)
            console.log(`=====> Fetching On Ledger DEX OUTPUT...`)
            const onLedgerOutput = await data.connection.send({
                command: 'tx',
                transaction: data.tx.hash
            })
            let deliveredAmount
            console.log('TX1 DEX OUTPUT', onLedgerOutput)
            paymentDetails.xrplOnLedgerOutput = onLedgerOutput
            try {
                deliveredAmount = onLedgerOutput.meta.DeliveredAmount
                if ((parseInt(deliveredAmount) || 0) > 0) {
                    console.log('onLedgerOutput -- DeliveredAmount', deliveredAmount)    
                } else {
                    throw new Error('Invalid deliveredAmount for TX1 DEX OUTPUT')
                }
            } catch (e) {
                throw new Error('Cannot determine exchange output, no TX1 "meta.DeliveredAmount" found.')
            }
            if (deliveredAmount) {
                const payoutTransaction = {
                    TransactionType: 'Payment',
                    Account: XPRL_HOTWALLET,
                    Fee: '20',
                    Destination: data.xrpDestination.to,
                    DestinationTag: data.xrpDestination.tag,
                    Amount: deliveredAmount,
                    Memos: paymentDetails.xrplTx.Memos
                }
                console.log('<< NOW PAYOUT THE CONVERTED XRP >>', payoutTransaction)
                const signAndSubmit = await new RippledWsClientSign(payoutTransaction, FAMILY_SEED, data.connection)
                console.log('------ FINAL TX2 PAYOUT RESULTS', signAndSubmit)
                paymentDetails.xrplTxPayout = signAndSubmit
            }

            console.log(`=====> Closing connection to rippled...`)
            await data.connection.close()
            return data.tx
        })
        .then(async tx => {
            // Persist TX details
            paymentDetails.xrplTxResult = tx
            return
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