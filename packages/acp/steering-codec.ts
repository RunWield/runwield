import { RequestError, type ParamsParser } from "@agentclientprotocol/sdk/unstable";
import type { JsonRecord, JsonValue } from "@runwield/parsing/jsonc";

/** RunWield's ACP method for injecting input into an active turn. */
export const ACP_STEERING_METHOD = "_session/steering";

interface AcpSteeringOptions {
    idleBehavior?: "promptRequired";
}

interface AcpSteeringMetadata {
    steering?: AcpSteeringOptions;
}

/** Steering request envelope. The server validates each prompt block before using it. */
export interface AcpSteeringRequest {
    sessionId: string;
    prompt: JsonValue[];
    _meta?: AcpSteeringMetadata;
}

export type AcpSteeringResponse =
    { outcome: "injected" } | { outcome: "promptRequired"; reason: "questionPending" | "noRunningTurn" };

type AcpParamsDecoder<Params> = Extract<ParamsParser<Params>, (...args: never[]) => Params>;

function isWireRecord<T>(value: T): value is T & JsonRecord {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidSteering(message: string): never {
    throw new RequestError(-32602, `${ACP_STEERING_METHOD} ${message}`, {});
}

/** Decode an ACP v1 extension request for the SDK's custom method handler. */
export const decodeAcpSteeringRequest: AcpParamsDecoder<AcpSteeringRequest> = (params) => {
    if (!isWireRecord(params) || typeof params.sessionId !== "string" || !params.sessionId.trim()) {
        invalidSteering("requires sessionId");
    }
    if (!Array.isArray(params.prompt) || params.prompt.length === 0) {
        invalidSteering("requires at least one prompt content block");
    }
    const metadata = params._meta;
    if (metadata !== undefined && !isWireRecord(metadata)) {
        invalidSteering("_meta must be an object");
    }
    const steering = metadata?.steering;
    if (steering !== undefined && !isWireRecord(steering)) {
        invalidSteering("_meta.steering must be an object");
    }
    const idleBehavior = steering?.idleBehavior;
    if (idleBehavior !== undefined && idleBehavior !== "promptRequired") {
        invalidSteering("idleBehavior must be promptRequired");
    }
    return params as JsonRecord & AcpSteeringRequest;
};
