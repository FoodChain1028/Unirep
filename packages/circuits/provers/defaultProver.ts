import path from 'path'
import { Circuit } from '../src'
import * as snarkjs from 'snarkjs'
import { SnarkProof, SnarkPublicSignals } from '@unirep/utils'

const buildPath = '../zksnarkBuild'

/**
 * The default prover that uses the circuits in default built folder `zksnarkBuild/`
 * @note
 * :::caution
 * The keys included are not safe for production use. A phase 2 trusted setup needs to be done before use.
 * :::
 * @example
 * ```ts
 * import { Circuit } from '@unirep/circuits'
 * import prover from '@unirep/circuits/provers/defaultProver'
 *
 * await prover.genProofAndPublicSignals(Circuit.signup, {
 *  // circuit inputs
 * })
 * ```
 */
export const defaultProver = {
    /**
     * Generate proof and public signals with `snarkjs.groth16.fullProve`
     * @param circuitName Name of the circuit, which can be chosen from `Circuit`
     * @param inputs The user inputs of the circuit
     * @returns snark proof and public signals
     */
    genProofAndPublicSignals: async (
        circuitName: string | Circuit,
        inputs: any
    ): Promise<any> => {
        const circuitWasmPath = path.join(
            __dirname,
            buildPath,
            `${circuitName}.wasm`
        )
        const zkeyPath = path.join(__dirname, buildPath, `${circuitName}.zkey`)
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
            inputs,
            circuitWasmPath,
            zkeyPath
        )

        return { proof, publicSignals }
    },

    /**
     * Verify the snark proof and public signals with `snarkjs.groth16.verify`
     * @param circuitName Name of the circuit, which can be chosen from `Circuit`
     * @param publicSignals The snark public signals that are generated from `genProofAndPublicSignals`
     * @param proof The snark proof that is generated from `genProofAndPublicSignals`
     * @returns True if the proof is valid, false otherwise
     */
    verifyProof: async (
        circuitName: string | Circuit,
        publicSignals: SnarkPublicSignals,
        proof: SnarkProof
    ): Promise<boolean> => {
        const vkey = require(path.join(buildPath, `${circuitName}.vkey.json`))
        return snarkjs.groth16.verify(vkey, publicSignals, proof)
    },

    /**
     * Get vkey from default built folder `zksnarkBuild/`
     * @param name Name of the circuit, which can be chosen from `Circuit`
     * @returns vkey of the circuit
     */
    getVKey: async (name: string | Circuit) => {
        return require(path.join(buildPath, `${name}.vkey.json`))
    },
}
