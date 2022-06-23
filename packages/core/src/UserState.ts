import { BigNumber, ethers } from 'ethers'
import assert from 'assert'
import { DB } from 'anondb'
import {
    IncrementalMerkleTree,
    hash5,
    stringifyBigInts,
    hashLeftRight,
    SparseMerkleTree,
    ZkIdentity,
    unstringifyBigInts,
} from '@unirep/crypto'
import { IAttestation, Attestation } from '@unirep/contracts'
import {
    defaultUserStateLeaf,
    genEpochKey,
    genNewSMT,
    genEpochKeyNullifier,
    genReputationNullifier,
} from './utils'
import { IReputation, IUserState, IUserStateLeaf } from './interfaces'
import Reputation from './Reputation'
import {
    Circuit,
    genProofAndPublicSignals,
    NUM_ATTESTATIONS_PER_PROOF,
} from '@unirep/circuits'
import { Prover, Synchronizer } from './Synchronizer'

const decodeBigIntArray = (input: string): bigint[] => {
    return unstringifyBigInts(JSON.parse(input))
}

export default class UserState extends Synchronizer {
    public id: ZkIdentity
    public commitment: bigint
    private _hasSignedUp: boolean = false

    public latestTransitionedEpoch: number // Latest epoch where the user has a record in the GST of that epoch
    public latestGSTLeafIndex: number // Leaf index of the latest GST where the user has a record in
    private latestUserStateLeaves: IUserStateLeaf[] // Latest non-default user state leaves
    private transitionedFromAttestations: { [key: string]: IAttestation[] } = {} // attestations in the latestTransitionedEpoch
    private newUserState: {
        newGSTLeaf: BigInt
        newUSTLeaves: IUserStateLeaf[]
    } = {
        newGSTLeaf: BigInt(0),
        newUSTLeaves: [],
    }

    constructor(
        db: DB,
        prover: Prover,
        unirepContract: ethers.Contract,
        _id: ZkIdentity,
        _hasSignedUp?: boolean,
        _latestTransitionedEpoch?: number,
        _latestGSTLeafIndex?: number,
        _latestUserStateLeaves?: IUserStateLeaf[],
        _transitionedFromAttestations?: { [key: string]: IAttestation[] }
    ) {
        super(db, prover, unirepContract)

        this.id = _id
        this.commitment = this.id.genIdentityCommitment()
        this.latestUserStateLeaves = []

        if (_hasSignedUp !== undefined) {
            assert(
                _latestTransitionedEpoch !== undefined,
                'UserState: User has signed up but missing latestTransitionedEpoch'
            )
            assert(
                _latestGSTLeafIndex !== undefined,
                'UserState: User has signed up but missing latestGSTLeafIndex'
            )

            this.latestTransitionedEpoch = _latestTransitionedEpoch
            this.latestGSTLeafIndex = _latestGSTLeafIndex
            if (_latestUserStateLeaves !== undefined)
                this.latestUserStateLeaves = _latestUserStateLeaves
            if (_transitionedFromAttestations !== undefined)
                this.transitionedFromAttestations =
                    _transitionedFromAttestations
            this._hasSignedUp = _hasSignedUp
        } else {
            this.latestTransitionedEpoch = 0
            this.latestGSTLeafIndex = 0
        }
    }

    async start() {
        await super.start()

        const [UserSignedUp] = this.unirepContract.filters.UserSignedUp()
            .topics as string[]
        const [EpochEnded] = this.unirepContract.filters.EpochEnded()
            .topics as string[]
        const [UserStateTransitioned] =
            this.unirepContract.filters.UserStateTransitioned()
                .topics as string[]
        this.on(UserSignedUp, async (event) => {
            const decodedData = this.unirepContract.interface.decodeEventLog(
                'UserSignedUp',
                event.data
            )

            const epoch = Number(event.topics[1])
            const commitment = BigInt(event.topics[2])
            const attesterId = Number(decodedData.attesterId)
            const airdrop = Number(decodedData.airdropAmount)
            try {
                await this.signUp(epoch, commitment, attesterId, airdrop)
            } catch (err) {
                console.log(err)
            }
        })
        this.on(EpochEnded, async (event) => {
            const epoch = Number(event.topics[1])
            try {
                await this.epochTransition(epoch)
            } catch (err) {
                console.log(err)
            }
        })
        this.on(UserStateTransitioned, async (event) => {
            const decodedData = this.unirepContract.interface.decodeEventLog(
                'UserStateTransitioned',
                event.data
            )
            const epoch = Number(event.topics[1])
            const GSTLeaf = BigInt(event.topics[2])
            const proofIndex = Number(decodedData.proofIndex)
            // get proof index data from db
            const proof = await this.loadUSTProof(proofIndex)
            const publicSignals = decodeBigIntArray(proof.publicSignals)
            const fromEpochSignalIndex = 4
            const fromEpoch = Number(publicSignals[fromEpochSignalIndex])
            if (!proof) {
                console.log(`Proof index ${proofIndex} is invalid`)
            }
            if (GSTLeaf === this.newUserState.newGSTLeaf) {
                try {
                    await this.userStateTransition(fromEpoch, GSTLeaf)
                } catch (err) {
                    console.log(err)
                }
            }
        })
    }

    public toJSON = () => {
        const userStateLeavesMapToString: { [key: string]: string } = {}
        for (const l of this.latestUserStateLeaves) {
            userStateLeavesMapToString[l.attesterId.toString()] =
                l.reputation.toJSON()
        }
        const transitionedFromAttestationsToString: {
            [key: string]: string[]
        } = {}
        const epoch = this.latestTransitionedEpoch
        for (
            let nonce = 0;
            nonce < this.settings.numEpochKeyNoncePerEpoch;
            nonce++
        ) {
            const epk = genEpochKey(
                this.id.identityNullifier,
                epoch,
                nonce
            ).toString()
            const attestations = this.transitionedFromAttestations[epk]
            if (attestations !== undefined)
                transitionedFromAttestationsToString[epk] = attestations.map(
                    (a: any) => JSON.stringify(a)
                )
        }
        return {
            idNullifier: this.id.identityNullifier,
            idCommitment: this.commitment,
            hasSignedUp: this.hasSignedUp,
            latestTransitionedEpoch: this.latestTransitionedEpoch,
            latestGSTLeafIndex: this.latestGSTLeafIndex,
            latestUserStateLeaves: userStateLeavesMapToString,
            transitionedFromAttestations: transitionedFromAttestationsToString,
        }
    }

    public static fromJSON = (
        db: DB,
        prover: Prover,
        unirepContract: ethers.Contract,
        identity: ZkIdentity,
        data: IUserState
    ) => {
        const _userState = typeof data === 'string' ? JSON.parse(data) : data
        const userStateLeaves: IUserStateLeaf[] = []
        const transitionedFromAttestations: { [key: string]: IAttestation[] } =
            {}
        for (const key in _userState.latestUserStateLeaves) {
            const parsedLeaf = JSON.parse(_userState.latestUserStateLeaves[key])
            const leaf: IUserStateLeaf = {
                attesterId: BigInt(key),
                reputation: new Reputation(
                    parsedLeaf.posRep,
                    parsedLeaf.negRep,
                    parsedLeaf.graffiti,
                    parsedLeaf.signUp
                ),
            }
            userStateLeaves.push(leaf)
        }
        for (const key in _userState.transitionedFromAttestations) {
            transitionedFromAttestations[key] = []
            for (const attest of _userState.transitionedFromAttestations[key]) {
                const parsedAttest = JSON.parse(attest)
                const attestation: IAttestation = new Attestation(
                    parsedAttest.attesterId,
                    parsedAttest.posRep,
                    parsedAttest.negRep,
                    parsedAttest.graffiti,
                    parsedAttest.signUp
                )
                transitionedFromAttestations[key].push(attestation)
            }
        }
        const userState = new this(
            db,
            prover,
            unirepContract,
            identity,
            _userState.hasSignedUp,
            _userState.latestTransitionedEpoch,
            _userState.latestGSTLeafIndex,
            userStateLeaves,
            transitionedFromAttestations
        )
        return userState
    }

    get hasSignedUp() {
        return this._hasSignedUp
    }

    /**
     * Proxy methods to get underlying UnirepState data
     */
    public getUnirepStateCurrentEpoch = async (): Promise<number> => {
        return (await this.loadCurrentEpoch()).number
    }

    public genGSTree = async (
        epoch: number
    ): Promise<IncrementalMerkleTree> => {
        await this._checkValidEpoch(epoch)
        const tree = new IncrementalMerkleTree(
            this.settings.globalStateTreeDepth,
            this.defaultGSTLeaf
        )
        const leaves = await this._db.findMany('GSTLeaf', {
            where: {
                epoch,
            },
            orderBy: {
                index: 'asc',
            },
        })
        for (const leaf of leaves) {
            tree.insert(leaf.hash)
        }
        return tree
    }

    async getNumGSTLeaves(epoch: number) {
        await this._checkValidEpoch(epoch)
        return this._db.count('GSTLeaf', {
            epoch: epoch,
        })
    }

    async getAttestations(epochKey: string): Promise<IAttestation[]> {
        await this._checkEpochKeyRange(epochKey)
        // TODO: transform db entries to IAttestation (they're already pretty similar)
        return this._db.findMany('Attestation', {
            where: {
                epochKey,
                valid: true,
            },
        })
    }

    async getEpochKeys(epoch: number) {
        await this._checkValidEpoch(epoch)

        // db isn't designed to handle epks right now, this is pretty
        // inefficient
        const attestations = await this._db.findMany('Attestation', {
            where: {
                epoch,
            },
        })
        const epks = attestations.reduce((acc, attestation) => {
            return {
                ...acc,
                [attestation.epochKey]: true,
            }
        }, {})
        return Object.keys(epks)
    }

    async loadUSTProof(index: number): Promise<any> {
        return this._db.findOne('Proof', {
            where: {
                event: 'IndexedUserStateTransitionProof',
                index,
                valid: true,
            },
        })
    }

    public getUnirepStateEpochTree = async (epoch: number) => {
        return this.genEpochTree(epoch)
    }

    public getUnirepState = () => {
        return this
    }

    /**
     * Get the epoch key nullifier of given epoch
     */
    public getEpochKeyNullifiers = (epoch: number): BigInt[] => {
        const nullifiers: BigInt[] = []
        for (
            let nonce = 0;
            nonce < this.settings.numEpochKeyNoncePerEpoch;
            nonce++
        ) {
            const nullifier = genEpochKeyNullifier(
                this.id.identityNullifier,
                epoch,
                nonce
            )
            nullifiers.push(nullifier)
        }
        return nullifiers
    }

    public getRepByAttester = (attesterId: BigInt): IReputation => {
        const leaf = this.latestUserStateLeaves.find(
            (leaf) => leaf.attesterId == attesterId
        )
        if (leaf !== undefined) return leaf.reputation
        else return Reputation.default()
    }

    /**
     * Check if user has signed up in Unirep
     */
    private _checkUserSignUp = () => {
        assert(this.hasSignedUp, 'UserState: User has not signed up yet')
    }

    /**
     * Check if user has not signed up in Unirep
     */
    private _checkUserNotSignUp = () => {
        assert(!this.hasSignedUp, 'UserState: User has already signed up')
    }

    /**
     * Check if epoch key nonce is valid
     */
    private _checkEpkNonce = (epochKeyNonce: number) => {
        assert(
            epochKeyNonce < this.settings.numEpochKeyNoncePerEpoch,
            `epochKeyNonce (${epochKeyNonce}) must be less than max epoch nonce`
        )
    }

    /**
     * Check if attester ID is valid
     */
    private _checkAttesterId = (attesterId: BigInt) => {
        assert(
            attesterId > BigInt(0),
            `UserState: attesterId must be greater than zero`
        )
        assert(
            attesterId < BigInt(2 ** this.settings.userStateTreeDepth),
            `UserState: attesterId exceeds total number of attesters`
        )
    }

    /**
     * Add a new epoch key to the list of epoch key of current epoch.
     */
    public signUp = async (
        epoch: number,
        identityCommitment: BigInt,
        attesterId?: number,
        airdropAmount?: number,
        blockNumber?: number
    ) => {
        // if commitment matches the user's commitment, update user state
        if (identityCommitment === this.commitment) {
            this._checkUserNotSignUp()

            const signUpInLeaf = 1
            if (attesterId && airdropAmount) {
                const stateLeave: IUserStateLeaf = {
                    attesterId: BigInt(attesterId),
                    reputation: Reputation.default().update(
                        BigNumber.from(airdropAmount),
                        BigNumber.from(0),
                        BigNumber.from(0),
                        BigNumber.from(signUpInLeaf)
                    ),
                }
                this.latestUserStateLeaves = [stateLeave]
            }
            this.latestTransitionedEpoch = epoch
            this.latestGSTLeafIndex = (await this.getNumGSTLeaves(epoch)) - 1
            this._hasSignedUp = true
        }
    }

    /**
     * Computes the user state tree with given state leaves
     */
    private _genUserStateTreeFromLeaves = (
        leaves: IUserStateLeaf[]
    ): SparseMerkleTree => {
        const USTree = genNewSMT(
            this.settings.userStateTreeDepth,
            defaultUserStateLeaf
        )

        for (const leaf of leaves) {
            USTree.update(leaf.attesterId, leaf.reputation.hash())
        }
        return USTree
    }

    /**
     * Computes the user state tree of given epoch
     */
    public genUserStateTree = (): SparseMerkleTree => {
        const leaves = this.latestUserStateLeaves
        return this._genUserStateTreeFromLeaves(leaves)
    }

    /**
     * Check if the root is one of the epoch tree roots in the given epoch
     */
    public epochTreeRootExists = async (
        epochTreeRoot: BigInt | string,
        epoch: number
    ): Promise<boolean> => {
        await this._checkValidEpoch(epoch)
        const found = await this._db.findOne('Epoch', {
            where: {
                number: epoch,
                epochRoot: epochTreeRoot.toString(),
            },
        })
        return !!found
    }

    /**
     * Update user state and unirep state according to user state transition event
     */
    public userStateTransition = async (fromEpoch: number, GSTLeaf: BigInt) => {
        if (this.hasSignedUp && this.latestTransitionedEpoch === fromEpoch) {
            await this._transition(GSTLeaf)
        }
        this.newUserState = {
            newGSTLeaf: BigInt(0),
            newUSTLeaves: [],
        }
    }

    public genVerifyEpochKeyProof = async (epochKeyNonce: number) => {
        this._checkUserSignUp()
        this._checkEpkNonce(epochKeyNonce)
        const epoch = this.latestTransitionedEpoch
        const epochKey = genEpochKey(
            this.id.identityNullifier,
            epoch,
            epochKeyNonce,
            this.settings.epochTreeDepth
        )
        const userStateTree = this.genUserStateTree()
        const GSTree = await this.genGSTree(epoch)
        const GSTProof = GSTree.createProof(this.latestGSTLeafIndex)

        const circuitInputs = stringifyBigInts({
            GST_path_elements: GSTProof.siblings,
            GST_path_index: GSTProof.pathIndices,
            GST_root: GSTree.root,
            identity_nullifier: this.id.identityNullifier,
            identity_trapdoor: this.id.trapdoor,
            user_tree_root: userStateTree.root,
            nonce: epochKeyNonce,
            epoch: epoch,
            epoch_key: epochKey,
        })

        const results = await genProofAndPublicSignals(
            Circuit.verifyEpochKey,
            circuitInputs
        )

        return {
            proof: results.proof,
            publicSignals: results.publicSignals,
            globalStateTree: results.publicSignals[0],
            epoch: results.publicSignals[1],
            epochKey: results.publicSignals[2],
        }
    }

    private _updateUserStateLeaf = (
        attestation: IAttestation,
        stateLeaves: IUserStateLeaf[]
    ): IUserStateLeaf[] => {
        const attesterId = BigInt(attestation.attesterId.toString())
        for (const leaf of stateLeaves) {
            if (leaf.attesterId === attesterId) {
                leaf.reputation = leaf.reputation.update(
                    attestation.posRep,
                    attestation.negRep,
                    attestation.graffiti,
                    attestation.signUp
                )
                return stateLeaves
            }
        }
        // If no matching state leaf, insert new one
        const newLeaf: IUserStateLeaf = {
            attesterId: attesterId,
            reputation: Reputation.default().update(
                attestation.posRep,
                attestation.negRep,
                attestation.graffiti,
                attestation.signUp
            ),
        }
        stateLeaves.push(newLeaf)
        return stateLeaves
    }

    private _saveAttestations = async () => {
        this._checkUserSignUp()
        const fromEpoch = this.latestTransitionedEpoch

        for (
            let nonce = 0;
            nonce < this.settings.numEpochKeyNoncePerEpoch;
            nonce++
        ) {
            const epochKey = genEpochKey(
                this.id.identityNullifier,
                fromEpoch,
                nonce,
                this.settings.epochTreeDepth
            ).toString()
            const attestations = await this.getAttestations(epochKey)
            this.transitionedFromAttestations[epochKey] = attestations.map(
                (attest) =>
                    new Attestation(
                        attest.attesterId,
                        attest.posRep,
                        attest.negRep,
                        attest.graffiti,
                        attest.signUp
                    )
            )
        }
    }

    public epochTransition = async (epoch: number) => {
        if (epoch === this.latestTransitionedEpoch) {
            // save latest attestations in user state
            await this._saveAttestations()
            this.newUserState = await this._genNewUserStateAfterTransition()
        }
    }

    private _genNewUserStateAfterTransition = async () => {
        this._checkUserSignUp()
        const fromEpoch = this.latestTransitionedEpoch

        let stateLeaves: IUserStateLeaf[]
        stateLeaves = this.latestUserStateLeaves.slice()

        for (
            let nonce = 0;
            nonce < this.settings.numEpochKeyNoncePerEpoch;
            nonce++
        ) {
            const epochKey = genEpochKey(
                this.id.identityNullifier,
                fromEpoch,
                nonce,
                this.settings.epochTreeDepth
            ).toString()
            const attestations = this.transitionedFromAttestations[epochKey]
            for (let i = 0; i < attestations?.length; i++) {
                const attestation = attestations[i]
                stateLeaves = this._updateUserStateLeaf(
                    attestation,
                    stateLeaves
                )
            }
        }

        // Gen new user state tree
        const newUserStateTree = this._genUserStateTreeFromLeaves(stateLeaves)

        // Gen new GST leaf
        const newGSTLeaf = hashLeftRight(this.commitment, newUserStateTree.root)
        return {
            newGSTLeaf: newGSTLeaf,
            newUSTLeaves: stateLeaves,
        }
    }

    private _genStartTransitionCircuitInputs = (
        fromNonce: number,
        userStateTreeRoot: BigInt,
        GSTreeProof: any,
        GSTreeRoot: BigInt
    ) => {
        // Circuit inputs
        const circuitInputs = stringifyBigInts({
            epoch: this.latestTransitionedEpoch,
            nonce: fromNonce,
            user_tree_root: userStateTreeRoot,
            identity_nullifier: this.id.identityNullifier,
            identity_trapdoor: this.id.trapdoor,
            GST_path_elements: GSTreeProof.siblings,
            GST_path_index: GSTreeProof.pathIndices,
            GST_root: GSTreeRoot,
        })

        // Circuit outputs
        // blinded user state and blinded hash chain are the inputs of processAttestationProofs
        const blindedUserState = hash5([
            this.id.identityNullifier,
            userStateTreeRoot,
            BigInt(this.latestTransitionedEpoch),
            BigInt(fromNonce),
            BigInt(0),
        ])
        const blindedHashChain = hash5([
            this.id.identityNullifier,
            BigInt(0), // hashchain starter
            BigInt(this.latestTransitionedEpoch),
            BigInt(fromNonce),
            BigInt(0),
        ])

        return {
            circuitInputs: circuitInputs,
            blindedUserState: blindedUserState,
            blindedHashChain: blindedHashChain,
        }
    }

    public genUserStateTransitionProofs = async () => {
        this._checkUserSignUp()
        const fromEpoch = this.latestTransitionedEpoch
        const fromNonce = 0

        // User state tree
        const fromEpochUserStateTree: SparseMerkleTree = this.genUserStateTree()
        const intermediateUserStateTreeRoots: BigInt[] = [
            fromEpochUserStateTree.root,
        ]
        const userStateLeafPathElements: any[] = []
        // GSTree
        const fromEpochGSTree: IncrementalMerkleTree = await this.genGSTree(
            fromEpoch
        )
        const GSTreeProof = fromEpochGSTree.createProof(this.latestGSTLeafIndex)
        const GSTreeRoot = fromEpochGSTree.root
        // Epoch tree
        const fromEpochTree = await this.genEpochTree(fromEpoch)
        const epochTreeRoot = fromEpochTree.root
        const epochKeyPathElements: any[] = []

        // start transition proof
        const startTransitionCircuitInputs =
            this._genStartTransitionCircuitInputs(
                fromNonce,
                intermediateUserStateTreeRoots[0],
                GSTreeProof,
                GSTreeRoot
            )

        // process attestation proof
        const processAttestationCircuitInputs: any[] = []
        const fromNonces: number[] = [fromNonce]
        const toNonces: number[] = []
        const hashChainStarter: BigInt[] = []
        const blindedUserState: BigInt[] = [
            startTransitionCircuitInputs.blindedUserState,
        ]
        const blindedHashChain: BigInt[] = []
        let reputationRecords = {}
        const selectors: number[] = []
        const attesterIds: string[] = []
        const oldPosReps: string[] = [],
            oldNegReps: string[] = [],
            oldGraffities: string[] = [],
            oldSignUps: string[] = []
        const posReps: string[] = [],
            negReps: string[] = [],
            graffities: string[] = [],
            overwriteGraffities: any[] = [],
            signUps: string[] = []
        const finalBlindedUserState: BigInt[] = []
        const finalUserState: BigInt[] = [intermediateUserStateTreeRoots[0]]
        const finalHashChain: BigInt[] = []
        for (
            let nonce = 0;
            nonce < this.settings.numEpochKeyNoncePerEpoch;
            nonce++
        ) {
            const epochKey = genEpochKey(
                this.id.identityNullifier,
                fromEpoch,
                nonce,
                this.settings.epochTreeDepth
            )
            let currentHashChain: BigInt = BigInt(0)

            // Blinded user state and hash chain of the epoch key
            toNonces.push(nonce)
            hashChainStarter.push(currentHashChain)

            // Attestations
            const attestations = await this.getAttestations(epochKey.toString())
            // TODO: update attestation types
            for (let i = 0; i < attestations.length; i++) {
                // Include a blinded user state and blinded hash chain per proof
                if (
                    i &&
                    i % NUM_ATTESTATIONS_PER_PROOF == 0 &&
                    i != NUM_ATTESTATIONS_PER_PROOF - 1
                ) {
                    toNonces.push(nonce)
                    fromNonces.push(nonce)
                    hashChainStarter.push(currentHashChain)
                    blindedUserState.push(
                        hash5([
                            this.id.identityNullifier,
                            fromEpochUserStateTree.root,
                            BigInt(fromEpoch),
                            BigInt(nonce),
                        ])
                    )
                }

                const attestation = new Attestation(
                    attestations[i].attesterId,
                    attestations[i].posRep,
                    attestations[i].negRep,
                    attestations[i].graffiti,
                    attestations[i].signUp
                )
                const attesterId: BigInt = BigInt(
                    attestation.attesterId.toString()
                )
                const rep = this.getRepByAttester(attesterId)

                if (reputationRecords[attesterId.toString()] === undefined) {
                    reputationRecords[attesterId.toString()] = new Reputation(
                        rep.posRep,
                        rep.negRep,
                        rep.graffiti,
                        rep.signUp
                    )
                }

                oldPosReps.push(reputationRecords[attesterId.toString()].posRep)
                oldNegReps.push(reputationRecords[attesterId.toString()].negRep)
                oldGraffities.push(
                    reputationRecords[attesterId.toString()].graffiti
                )
                oldSignUps.push(reputationRecords[attesterId.toString()].signUp)

                // Add UST merkle proof to the list
                const USTLeafPathElements =
                    fromEpochUserStateTree.createProof(attesterId)
                userStateLeafPathElements.push(USTLeafPathElements)

                // Update attestation record
                reputationRecords[attesterId.toString()].update(
                    attestation.posRep,
                    attestation.negRep,
                    attestation.graffiti,
                    attestation.signUp
                )

                // Update UST
                fromEpochUserStateTree.update(
                    attesterId,
                    reputationRecords[attesterId.toString()].hash()
                )
                // Add new UST root to intermediate UST roots
                intermediateUserStateTreeRoots.push(fromEpochUserStateTree.root)

                selectors.push(1)
                attesterIds.push(attesterId.toString())
                posReps.push(attestation.posRep.toString())
                negReps.push(attestation.negRep.toString())
                graffities.push(attestation.graffiti.toString())
                overwriteGraffities.push(attestation.graffiti.toString() != '0')
                signUps.push(attestation.signUp.toString())

                // Update current hashchain result
                const attestationHash = attestation.hash()
                currentHashChain = hashLeftRight(
                    attestationHash,
                    currentHashChain
                )
            }
            // Fill in blank data for non-exist attestation
            const filledAttestationNum = attestations.length
                ? Math.ceil(attestations.length / NUM_ATTESTATIONS_PER_PROOF) *
                  NUM_ATTESTATIONS_PER_PROOF
                : NUM_ATTESTATIONS_PER_PROOF
            for (
                let i = 0;
                i < filledAttestationNum - attestations.length;
                i++
            ) {
                oldPosReps.push('0')
                oldNegReps.push('0')
                oldGraffities.push('0')
                oldSignUps.push('0')

                const USTLeafZeroPathElements =
                    fromEpochUserStateTree.createProof(BigInt(0))
                userStateLeafPathElements.push(USTLeafZeroPathElements)
                intermediateUserStateTreeRoots.push(fromEpochUserStateTree.root)

                selectors.push(0)
                attesterIds.push('0')
                posReps.push('0')
                negReps.push('0')
                graffities.push('0')
                overwriteGraffities.push('0')
                signUps.push('0')
            }
            epochKeyPathElements.push(fromEpochTree.createProof(epochKey))
            // finalUserState.push(fromEpochUserStateTree.root)
            finalHashChain.push(currentHashChain)
            blindedUserState.push(
                hash5([
                    this.id.identityNullifier,
                    fromEpochUserStateTree.root,
                    BigInt(fromEpoch),
                    BigInt(nonce),
                ])
            )
            blindedHashChain.push(
                hash5([
                    this.id.identityNullifier,
                    currentHashChain,
                    BigInt(fromEpoch),
                    BigInt(nonce),
                ])
            )
            if (nonce != this.settings.numEpochKeyNoncePerEpoch - 1)
                fromNonces.push(nonce)
        }

        for (let i = 0; i < fromNonces.length; i++) {
            const startIdx = NUM_ATTESTATIONS_PER_PROOF * i
            const endIdx = NUM_ATTESTATIONS_PER_PROOF * (i + 1)
            processAttestationCircuitInputs.push(
                stringifyBigInts({
                    epoch: fromEpoch,
                    from_nonce: fromNonces[i],
                    to_nonce: toNonces[i],
                    identity_nullifier: this.id.identityNullifier,
                    intermediate_user_state_tree_roots:
                        intermediateUserStateTreeRoots.slice(
                            startIdx,
                            endIdx + 1
                        ),
                    old_pos_reps: oldPosReps.slice(startIdx, endIdx),
                    old_neg_reps: oldNegReps.slice(startIdx, endIdx),
                    old_graffities: oldGraffities.slice(startIdx, endIdx),
                    old_sign_ups: oldSignUps.slice(startIdx, endIdx),
                    path_elements: userStateLeafPathElements.slice(
                        startIdx,
                        endIdx
                    ),
                    attester_ids: attesterIds.slice(startIdx, endIdx),
                    pos_reps: posReps.slice(startIdx, endIdx),
                    neg_reps: negReps.slice(startIdx, endIdx),
                    graffities: graffities.slice(startIdx, endIdx),
                    overwrite_graffities: overwriteGraffities.slice(
                        startIdx,
                        endIdx
                    ),
                    sign_ups: signUps.slice(startIdx, endIdx),
                    selectors: selectors.slice(startIdx, endIdx),
                    hash_chain_starter: hashChainStarter[i],
                    input_blinded_user_state: blindedUserState[i],
                })
            )
        }

        // final user state transition proof
        const startEpochKeyNonce = 0
        const endEpochKeyNonce = this.settings.numEpochKeyNoncePerEpoch - 1
        finalUserState.push(fromEpochUserStateTree.root)
        finalBlindedUserState.push(
            hash5([
                this.id.identityNullifier,
                finalUserState[0],
                BigInt(fromEpoch),
                BigInt(startEpochKeyNonce),
            ])
        )
        finalBlindedUserState.push(
            hash5([
                this.id.identityNullifier,
                finalUserState[1],
                BigInt(fromEpoch),
                BigInt(endEpochKeyNonce),
            ])
        )
        const finalTransitionCircuitInputs = stringifyBigInts({
            epoch: fromEpoch,
            blinded_user_state: finalBlindedUserState,
            intermediate_user_state_tree_roots: finalUserState,
            start_epoch_key_nonce: startEpochKeyNonce,
            end_epoch_key_nonce: endEpochKeyNonce,
            identity_nullifier: this.id.identityNullifier,
            identity_trapdoor: this.id.trapdoor,
            GST_path_elements: GSTreeProof.siblings,
            GST_path_index: GSTreeProof.pathIndices,
            GST_root: GSTreeRoot,
            epk_path_elements: epochKeyPathElements,
            hash_chain_results: finalHashChain,
            blinded_hash_chain_results: blindedHashChain,
            epoch_tree_root: epochTreeRoot,
        })

        // Generate proofs
        const startTransitionresults = await genProofAndPublicSignals(
            Circuit.startTransition,
            startTransitionCircuitInputs.circuitInputs
        )

        const processAttestationProofs: any[] = []
        for (let i = 0; i < processAttestationCircuitInputs.length; i++) {
            const results = await genProofAndPublicSignals(
                Circuit.processAttestations,
                processAttestationCircuitInputs[i]
            )
            processAttestationProofs.push({
                proof: results.proof,
                publicSignals: results.publicSignals,
                outputBlindedUserState: results.publicSignals[0],
                outputBlindedHashChain: results.publicSignals[1],
                inputBlindedUserState: results.publicSignals[2],
            })
        }

        const finalProofResults = await genProofAndPublicSignals(
            Circuit.userStateTransition,
            finalTransitionCircuitInputs
        )

        return {
            startTransitionProof: {
                proof: startTransitionresults.proof,
                publicSignals: startTransitionresults.publicSignals,
                blindedUserState: startTransitionresults.publicSignals[0],
                blindedHashChain: startTransitionresults.publicSignals[1],
                globalStateTreeRoot: startTransitionresults.publicSignals[2],
            },
            processAttestationProofs: processAttestationProofs,
            finalTransitionProof: {
                proof: finalProofResults.proof,
                publicSignals: finalProofResults.publicSignals,
                newGlobalStateTreeLeaf: finalProofResults.publicSignals[0],
                epochKeyNullifiers: finalProofResults.publicSignals.slice(
                    1,
                    1 + this.settings.numEpochKeyNoncePerEpoch
                ),
                transitionedFromEpoch:
                    finalProofResults.publicSignals[
                        1 + this.settings.numEpochKeyNoncePerEpoch
                    ],
                blindedUserStates: finalProofResults.publicSignals.slice(
                    2 + this.settings.numEpochKeyNoncePerEpoch,
                    4 + this.settings.numEpochKeyNoncePerEpoch
                ),
                fromGSTRoot:
                    finalProofResults.publicSignals[
                        4 + this.settings.numEpochKeyNoncePerEpoch
                    ],
                blindedHashChains: finalProofResults.publicSignals.slice(
                    5 + this.settings.numEpochKeyNoncePerEpoch,
                    5 + 2 * this.settings.numEpochKeyNoncePerEpoch
                ),
                fromEpochTree:
                    finalProofResults.publicSignals[
                        5 + 2 * this.settings.numEpochKeyNoncePerEpoch
                    ],
            },
        }
    }

    /**
     * Update transition data including latest transition epoch, GST leaf index and user state tree leaves.
     */
    private _transition = async (newLeaf: BigInt) => {
        this._checkUserSignUp()

        const fromEpoch = this.latestTransitionedEpoch
        const transitionToEpoch = (await this.loadCurrentEpoch()).number
        const transitionToGSTIndex =
            (await this.getNumGSTLeaves(transitionToEpoch)) - 1
        const newState = this.newUserState
        if (newLeaf !== newState.newGSTLeaf) {
            console.error('UserState: new GST leaf mismatch')
            return
        }
        const latestStateLeaves = newState.newUSTLeaves
        assert(
            fromEpoch < transitionToEpoch,
            'Can not transition to same epoch'
        )

        this.latestTransitionedEpoch = transitionToEpoch
        this.latestGSTLeafIndex = transitionToGSTIndex

        // Update user state leaves
        this.latestUserStateLeaves = latestStateLeaves.slice()
    }

    public genProveReputationProof = async (
        attesterId: BigInt,
        epkNonce: number,
        minRep?: number,
        proveGraffiti?: BigInt,
        graffitiPreImage?: BigInt,
        nonceList?: BigInt[]
    ) => {
        this._checkUserSignUp()
        this._checkEpkNonce(epkNonce)

        if (nonceList == undefined)
            nonceList = new Array(this.settings.maxReputationBudget).fill(
                BigInt(-1)
            )
        assert(
            nonceList.length == this.settings.maxReputationBudget,
            `Length of nonce list should be ${this.settings.maxReputationBudget}`
        )
        const epoch = this.latestTransitionedEpoch
        const epochKey = genEpochKey(this.id.identityNullifier, epoch, epkNonce)
        const rep = this.getRepByAttester(attesterId)
        const posRep = rep.posRep
        const negRep = rep.negRep
        const graffiti = rep.graffiti
        const signUp = rep.signUp
        const userStateTree = this.genUserStateTree()
        const GSTree = await this.genGSTree(epoch)
        const GSTreeProof = GSTree.createProof(this.latestGSTLeafIndex)
        const GSTreeRoot = GSTree.root
        const USTPathElements = userStateTree.createProof(attesterId)
        const selectors: BigInt[] = []
        const nonceExist = {}
        let repNullifiersAmount = 0
        for (let i = 0; i < this.settings.maxReputationBudget; i++) {
            if (nonceList[i] !== BigInt(-1)) {
                assert(
                    nonceExist[nonceList[i].toString()] == undefined,
                    'cannot submit duplicated nonce to compute reputation nullifiers'
                )
                repNullifiersAmount++
                selectors[i] = BigInt(1)
                nonceExist[nonceList[i].toString()] = 1
            } else {
                selectors[i] = BigInt(0)
            }
        }

        // check if the nullifiers are submitted before
        let nonceStarter = -1
        if (repNullifiersAmount > 0) {
            // find valid nonce starter
            for (let n = 0; n < Number(posRep) - Number(negRep); n++) {
                const reputationNullifier = genReputationNullifier(
                    this.id.identityNullifier,
                    epoch,
                    n,
                    attesterId
                )
                if (!(await this.nullifierExist(reputationNullifier))) {
                    nonceStarter = n
                    break
                }
            }
            assert(nonceStarter != -1, 'All nullifiers are spent')
            assert(
                nonceStarter + repNullifiersAmount <=
                    Number(posRep) - Number(negRep),
                'Not enough reputation to spend'
            )
        }

        const circuitInputs = stringifyBigInts({
            epoch: epoch,
            epoch_key_nonce: epkNonce,
            epoch_key: epochKey,
            identity_nullifier: this.id.identityNullifier,
            identity_trapdoor: this.id.trapdoor,
            user_tree_root: userStateTree.root,
            GST_path_index: GSTreeProof.pathIndices,
            GST_path_elements: GSTreeProof.siblings,
            GST_root: GSTreeRoot,
            attester_id: attesterId,
            pos_rep: posRep,
            neg_rep: negRep,
            graffiti: graffiti,
            sign_up: signUp,
            UST_path_elements: USTPathElements,
            rep_nullifiers_amount: repNullifiersAmount,
            selectors: selectors,
            rep_nonce: nonceList,
            min_rep: minRep === undefined ? 0 : minRep,
            prove_graffiti: proveGraffiti === undefined ? 0 : proveGraffiti,
            graffiti_pre_image:
                graffitiPreImage === undefined ? 0 : graffitiPreImage,
        })

        const results = await genProofAndPublicSignals(
            Circuit.proveReputation,
            circuitInputs
        )

        return {
            proof: results['proof'],
            publicSignals: results['publicSignals'],
            reputationNullifiers: results['publicSignals'].slice(
                0,
                this.settings.maxReputationBudget
            ),
            epoch: results['publicSignals'][this.settings.maxReputationBudget],
            epochKey:
                results['publicSignals'][this.settings.maxReputationBudget + 1],
            globalStatetreeRoot:
                results['publicSignals'][this.settings.maxReputationBudget + 2],
            attesterId:
                results['publicSignals'][this.settings.maxReputationBudget + 3],
            proveReputationAmount:
                results['publicSignals'][this.settings.maxReputationBudget + 4],
            minRep: results['publicSignals'][
                this.settings.maxReputationBudget + 5
            ],
            proveGraffiti:
                results['publicSignals'][this.settings.maxReputationBudget + 6],
            graffitiPreImage:
                results['publicSignals'][this.settings.maxReputationBudget + 7],
        }
    }

    public genUserSignUpProof = async (attesterId: BigInt) => {
        this._checkUserSignUp()
        this._checkAttesterId(attesterId)
        const epoch = this.latestTransitionedEpoch
        const nonce = 0 // fixed epk nonce
        const epochKey = genEpochKey(this.id.identityNullifier, epoch, nonce)
        const rep = this.getRepByAttester(attesterId)
        const posRep = rep.posRep
        const negRep = rep.negRep
        const graffiti = rep.graffiti
        const signUp = rep.signUp
        const userStateTree = this.genUserStateTree()
        const GSTree = await this.genGSTree(epoch)
        const GSTreeProof = GSTree.createProof(this.latestGSTLeafIndex)
        const GSTreeRoot = GSTree.root
        const USTPathElements = userStateTree.createProof(attesterId)

        const circuitInputs = stringifyBigInts({
            epoch: epoch,
            epoch_key: epochKey,
            identity_nullifier: this.id.identityNullifier,
            identity_trapdoor: this.id.trapdoor,
            user_tree_root: userStateTree.root,
            GST_path_index: GSTreeProof.pathIndices,
            GST_path_elements: GSTreeProof.siblings,
            GST_root: GSTreeRoot,
            attester_id: attesterId,
            pos_rep: posRep,
            neg_rep: negRep,
            graffiti: graffiti,
            sign_up: signUp,
            UST_path_elements: USTPathElements,
        })
        const results = await genProofAndPublicSignals(
            Circuit.proveUserSignUp,
            circuitInputs
        )

        return {
            proof: results['proof'],
            publicSignals: results['publicSignals'],
            epoch: results['publicSignals'][0],
            epochKey: results['publicSignals'][1],
            globalStateTreeRoot: results['publicSignals'][2],
            attesterId: results['publicSignals'][3],
            userHasSignedUp: results['publicSignals'][4],
        }
    }
}

export { Reputation, UserState }
