const BunqJSClient = require("@bunq-community/bunq-js-client").default;
const customStore = require("./custom_store")(__dirname + "/storage.json")
const BunqClient = new BunqJSClient(customStore)
const Fetch = require('node-fetch')
const xrparrotStorage = require('../xrparrotStorage.json')

const ENCRYPTION_KEY = xrparrotStorage.ENCRYPTION_KEY
const API_KEY = xrparrotStorage.API_KEY
const DEVICE_NAME = xrparrotStorage.DEVICE_NAME
const ENVIRONMENT = xrparrotStorage.ENVIRONMENT
const PERMITTED_IPS = xrparrotStorage.PERMITTED_IPS

const API_TOKENS = xrparrotStorage.API_TOKENS
const API_ENDPOINTS = xrparrotStorage.API_ENDPOINTS

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

const getPayments = async (userid, monetaryaccountid, options) => {
    // get payments
    const payments = await BunqClient.api.payment
        .list(userid, monetaryaccountid, options)
        .catch(error => {
            throw error
        });

    return payments
}

const getUsers = () => BunqClient.getUsers(true)

// run setup and get payments
setup().then(async setup => {
    const MODE = process.argv.length > 2 && process.argv[2].toUpperCase() === 'PROD' ? 'PROD' : 'TEST'

    const users = await getUsers()
    const userType = Object.keys(users)[0] // UserCompany / UserPerson
    const accounts = await getMonetaryAccounts(users[userType].id);
    const activeAccounts = accounts.filter(account => {
        return (
            account.MonetaryAccountBank &&
            account.MonetaryAccountBank.status === "ACTIVE"
        )
    })

    return Fetch(API_ENDPOINTS[MODE] + 'payment-cursor', { method: 'GET', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_TOKENS[MODE] } })
        .then(res => res.json())
        .then(json => { 
            console.log(json.data)
            // process.exit(0)
            return json.data 
        })
        .then(id => getPayments(users[userType].id, activeAccounts[0].MonetaryAccountBank.id, { count: 200, newer_id: id, older_id: false }))
        .then(payments => {
            console.log(payments)
            return Fetch(API_ENDPOINTS[MODE] + 'payments', {
                method: 'POST', 
                body: JSON.stringify(payments.map(p => { return p.Payment })), 
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_TOKENS[MODE] }
            })
            .then(res => res.json())
            .then(json => {
                console.log(json)
                return
            })
        })
        .then(() => {
            console.log('Done')
            process.exit()
        })
})
.catch(error => {
    console.log(error)
    process.exit()
})