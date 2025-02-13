// @ts-ignore
import { ethers } from 'hardhat'
import { expect } from 'chai'
import { Identity } from '@semaphore-protocol/identity'
import { F } from '@unirep/utils'
import { deployUnirep } from '@unirep/contracts/deploy'

import { EPOCH_LENGTH, genUnirepState, genUserState } from './utils'
import { bootstrapUsers, bootstrapAttestations } from './test'

describe('User state', function () {
    this.timeout(0)
    let unirepContract

    before(async () => {
        const accounts = await ethers.getSigners()
        unirepContract = await deployUnirep(accounts[0])
    })

    {
        let snapshot
        beforeEach(async () => {
            snapshot = await ethers.provider.send('evm_snapshot', [])
            const accounts = await ethers.getSigners()
            const attester = accounts[1]
            await unirepContract
                .connect(attester)
                .attesterSignUp(EPOCH_LENGTH)
                .then((t) => t.wait())
            const synchronizer = await genUnirepState(
                ethers.provider,
                unirepContract.address,
                BigInt(attester.address)
            )
            await bootstrapUsers(synchronizer, attester)
            await bootstrapAttestations(synchronizer, attester)
            synchronizer.stop()
        })

        afterEach(async () => {
            await ethers.provider.send('evm_revert', [snapshot])
        })
    }

    it('should correctly get overflowed data', async () => {
        const accounts = await ethers.getSigners()
        const attester = accounts[1]
        const attesterId = BigInt(attester.address)
        const id = new Identity()
        const userState = await genUserState(
            ethers.provider,
            unirepContract.address,
            id,
            attesterId
        )

        const epoch = await userState.sync.loadCurrentEpoch()

        const { publicSignals, proof } = await userState.genUserSignUpProof({
            epoch,
        })
        await unirepContract
            .connect(attester)
            .userSignUp(publicSignals, proof)
            .then((t) => t.wait())
        const epk = userState.getEpochKeys(epoch, 1) as bigint
        const fieldIndex = 1
        const v0 = F - BigInt(1)
        const v1 = BigInt(12409124)
        const final = (v0 + v1) % F
        await unirepContract
            .connect(attester)
            .attest(epk, epoch, fieldIndex, v0)
            .then((t) => t.wait())
        await unirepContract
            .connect(attester)
            .attest(epk, epoch, fieldIndex, v1)
            .then((t) => t.wait())
        await userState.waitForSync()
        {
            const data = await userState.getData()
            expect(data[fieldIndex]).to.equal(final)
        }
        {
            const data = await userState.getDataByEpochKey(epk, epoch)
            expect(data[fieldIndex]).to.equal(final)
        }
        userState.stop()
    })

    it('should correctly get the latest data', async () => {
        const accounts = await ethers.getSigners()
        const attester = accounts[1]
        const attesterId = BigInt(attester.address)
        const id = new Identity()
        const userState = await genUserState(
            ethers.provider,
            unirepContract.address,
            id,
            attesterId
        )

        const epoch = await userState.sync.loadCurrentEpoch()

        const { publicSignals, proof } = await userState.genUserSignUpProof({
            epoch,
        })
        await unirepContract
            .connect(attester)
            .userSignUp(publicSignals, proof)
            .then((t) => t.wait())
        const epk0 = userState.getEpochKeys(epoch, 0) as bigint
        const epk1 = userState.getEpochKeys(epoch, 1) as bigint
        const fieldIndex = userState.sync.settings.sumFieldCount
        const firstReplData = BigInt(12345)
        const secondReplData = BigInt(23456)
        await unirepContract
            .connect(attester)
            .attest(epk0, epoch, fieldIndex, firstReplData)
            .then((t) => t.wait())
        await unirepContract
            .connect(attester)
            .attest(epk1, epoch, fieldIndex, secondReplData)
            .then((t) => t.wait())
        await userState.waitForSync()
        {
            const data = await userState.getData()
            const parsedData = userState.parseReplData(data[fieldIndex])
            expect(parsedData.data.toString()).to.equal(
                secondReplData.toString()
            )
        }
        {
            const data = await userState.getDataByEpochKey(epk0, epoch)
            const parsedData = userState.parseReplData(data[fieldIndex])
            expect(parsedData.data.toString()).to.equal(
                firstReplData.toString()
            )
        }
        {
            const data = await userState.getDataByEpochKey(epk1, epoch)
            const parsedData = userState.parseReplData(data[fieldIndex])
            expect(parsedData.data.toString()).to.equal(
                secondReplData.toString()
            )
        }
        userState.stop()
    })

    it('user sign up proof', async () => {
        const accounts = await ethers.getSigners()
        const attester = accounts[1]
        const attesterId = BigInt(attester.address)
        const id = new Identity()
        const userState = await genUserState(
            ethers.provider,
            unirepContract.address,
            id,
            attesterId
        )

        const epoch = await userState.sync.loadCurrentEpoch()

        const { publicSignals, proof } = await userState.genUserSignUpProof({
            epoch,
        })
        const r = await unirepContract
            .connect(attester)
            .userSignUp(publicSignals, proof)
            .then((t) => t.wait())
        expect(r.status).equal(1)
        userState.stop()
    })

    it('epoch key proof', async () => {
        const accounts = await ethers.getSigners()
        const attester = accounts[1]
        const attesterId = BigInt(attester.address)
        const id = new Identity()
        const userState = await genUserState(
            ethers.provider,
            unirepContract.address,
            id,
            attesterId
        )
        const epoch = await userState.sync.loadCurrentEpoch()

        {
            const { publicSignals, proof } = await userState.genUserSignUpProof(
                { epoch }
            )
            await unirepContract
                .connect(attester)
                .userSignUp(publicSignals, proof)
                .then((t) => t.wait())
        }

        await userState.waitForSync()
        const proof = await userState.genEpochKeyProof({ epoch })
        const valid = await proof.verify()
        expect(valid).to.be.true
        userState.stop()
    })

    it('ust proof', async () => {
        const accounts = await ethers.getSigners()
        const attester = accounts[1]
        const attesterId = BigInt(attester.address)
        const id = new Identity()
        const userState = await genUserState(
            ethers.provider,
            unirepContract.address,
            id,
            attesterId
        )
        const epoch = await userState.sync.loadCurrentEpoch()

        {
            const { publicSignals, proof } = await userState.genUserSignUpProof(
                { epoch }
            )
            await unirepContract
                .connect(attester)
                .userSignUp(publicSignals, proof)
                .then((t) => t.wait())
        }
        await userState.waitForSync()
        const oldEpoch = await userState.latestTransitionedEpoch()
        // epoch transition
        await ethers.provider.send('evm_increaseTime', [EPOCH_LENGTH])
        await ethers.provider.send('evm_mine', [])
        {
            await userState.waitForSync()
            const toEpoch = await userState.sync.loadCurrentEpoch()
            const { publicSignals, proof } =
                await userState.genUserStateTransitionProof({ toEpoch })
            // submit it
            await unirepContract
                .connect(accounts[4])
                .userStateTransition(publicSignals, proof)
                .then((t) => t.wait())
        }
        await userState.waitForSync()
        const newEpoch = await userState.latestTransitionedEpoch()
        expect(newEpoch).equal(oldEpoch + 1)
        userState.stop()
    })

    it('reputation proof', async () => {
        const accounts = await ethers.getSigners()
        const attester = accounts[1]
        const attesterId = BigInt(attester.address)
        const id = new Identity()
        const userState = await genUserState(
            ethers.provider,
            unirepContract.address,
            id,
            attesterId
        )
        const epoch = await userState.sync.loadCurrentEpoch()
        {
            const { publicSignals, proof } = await userState.genUserSignUpProof(
                { epoch }
            )
            await unirepContract
                .connect(attester)
                .userSignUp(publicSignals, proof)
                .then((t) => t.wait())
        }
        await userState.waitForSync()
        // we're signed up, now run an attestation
        const epochKeys = userState.getEpochKeys(epoch) as bigint[]
        const [epk] = epochKeys
        const fieldIndex = 0
        const val = 1389
        // now submit the attestation from the attester
        await unirepContract
            .connect(attester)
            .attest(epk, epoch, fieldIndex, val)
            .then((t) => t.wait())
        await userState.waitForSync()
        // now commit the attetstations

        await ethers.provider.send('evm_increaseTime', [EPOCH_LENGTH])
        await ethers.provider.send('evm_mine', [])

        // now check the reputation
        const checkPromises = epochKeys.map(async (key) => {
            const data = await userState.getDataByEpochKey(key, epoch)
            if (key.toString() === epk.toString()) {
                expect(data[fieldIndex]).to.equal(val)
                data.forEach((d, i) => {
                    if (i === fieldIndex) return
                    expect(d).to.equal(0)
                })
            } else {
                data.forEach((d) => expect(d).to.equal(0))
            }
        })
        await Promise.all(checkPromises)
        // then run an epoch transition and check the rep
        {
            await userState.waitForSync()
            const toEpoch = await userState.sync.loadCurrentEpoch()
            const { publicSignals, proof } =
                await userState.genUserStateTransitionProof({ toEpoch })
            // submit it
            await unirepContract
                .connect(accounts[4])
                .userStateTransition(publicSignals, proof)
                .then((t) => t.wait())
        }
        await userState.waitForSync()
        {
            const currentEpoch = await userState.sync.loadCurrentEpoch()
            const data = await userState.getData(Number(currentEpoch))
            expect(data[fieldIndex]).to.equal(val)
            data.forEach((d, i) => {
                if (i === fieldIndex) return
                expect(d).to.equal(0)
            })
        }

        await userState.waitForSync()
        const proof = await userState.genProveReputationProof({
            epkNonce: 0,
            minRep: 1,
        })

        const valid = await proof.verify()
        expect(valid).to.be.true
        userState.stop()
    })
})
