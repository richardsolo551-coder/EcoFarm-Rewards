// RewardDistributor.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface Metrics {
  "carbon-sequestered": number;
  "water-saved": number;
  "yield-increase": number;
}

interface VerifiedData {
  "quality-score": number;
  "impact-metrics": Metrics;
  farmer: string;
}

interface RewardedSubmission {
  rewarded: boolean;
  amount: number;
  timestamp: number;
}

interface FarmerHistory {
  "total-rewards": number;
  "last-claim": number;
  "submission-count": number;
}

interface RewardConfig {
  "base-reward-rate": number;
  "carbon-multiplier": number;
  "water-multiplier": number;
  "yield-multiplier": number;
  "quality-threshold": number;
  "tier-multipliers": number[];
}

interface ConfigHistory {
  "base-rate": number;
  "carbon-mul": number;
  "water-mul": number;
  "yield-mul": number;
  threshold: number;
  timestamp: number;
}

interface ContractState {
  contractOwner: string;
  paused: boolean;
  baseRewardRate: number;
  carbonMultiplier: number;
  waterMultiplier: number;
  yieldMultiplier: number;
  qualityThreshold: number;
  ecoTokenContract: string;
  dataVerifierContract: string;
  stakingPoolContract: string;
  totalRewardsDistributed: number;
  rewardTierMultipliers: number[];
  rewardedSubmissions: Map<number, RewardedSubmission>;
  farmerRewardHistory: Map<string, FarmerHistory>;
  rewardConfigHistory: Map<number, ConfigHistory>;
  blockHeight: number;
}

// Mock trait implementations
class MockEcoToken {
  mint(amount: number, recipient: string): ClarityResponse<boolean> {
    return { ok: true, value: true };
  }
}

class MockDataVerifier {
  getVerifiedData(submissionId: number): ClarityResponse<VerifiedData> {
    return { ok: true, value: { "quality-score": 80, "impact-metrics": { "carbon-sequestered": 10, "water-saved": 5, "yield-increase": 15 }, farmer: "farmer1" } };
  }

  markRewarded(submissionId: number): ClarityResponse<boolean> {
    return { ok: true, value: true };
  }
}

class MockStakingPool {
  getStakeMultiplier(farmer: string): ClarityResponse<number> {
    return { ok: true, value: 150 }; // 150%
  }
}

// Mock contract implementation
class RewardDistributorMock {
  private state: ContractState = {
    contractOwner: "deployer",
    paused: false,
    baseRewardRate: 100,
    carbonMultiplier: 50,
    waterMultiplier: 30,
    yieldMultiplier: 20,
    qualityThreshold: 50,
    ecoTokenContract: "eco-token",
    dataVerifierContract: "data-verifier",
    stakingPoolContract: "staking-pool",
    totalRewardsDistributed: 0,
    rewardTierMultipliers: [100, 150, 200],
    rewardedSubmissions: new Map(),
    farmerRewardHistory: new Map(),
    rewardConfigHistory: new Map(),
    blockHeight: 1000,
  };

  private ecoToken = new MockEcoToken();
  private dataVerifier = new MockDataVerifier();
  private stakingPool = new MockStakingPool();

  private ERR_NOT_AUTHORIZED = 100;
  private ERR_INVALID_SUBMISSION = 101;
  private ERR_ALREADY_REWARDED = 102;
  private ERR_ZERO_REWARD = 110;
  private ERR_PAUSED = 105;
  private MICRO_ECO = 1000000;

  // Simulate block height increase
  private incrementBlockHeight() {
    this.state.blockHeight += 1;
  }

  distributeReward(caller: string, submissionId: number): ClarityResponse<number> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }

    const verifiedDataResp = this.dataVerifier.getVerifiedData(submissionId);
    if (!verifiedDataResp.ok) {
      return { ok: false, value: this.ERR_INVALID_SUBMISSION };
    }
    const verifiedData = verifiedDataResp.value as VerifiedData;

    const existingReward = this.state.rewardedSubmissions.get(submissionId) ?? { rewarded: false, amount: 0, timestamp: 0 };
    if (existingReward.rewarded) {
      return { ok: false, value: this.ERR_ALREADY_REWARDED };
    }

    if (verifiedData["quality-score"] < this.state.qualityThreshold) {
      return { ok: false, value: 108 }; // ERR_DATA_NOT_VERIFIED
    }

    const stakeMultiplierResp = this.stakingPool.getStakeMultiplier(verifiedData.farmer);
    if (!stakeMultiplierResp.ok) {
      return { ok: false, value: 106 }; // ERR_INVALID_MULTIPLIER
    }
    const stakeMultiplier = stakeMultiplierResp.value as number;

    const rewardAmount = this.calculateReward(verifiedData["quality-score"], verifiedData["impact-metrics"], stakeMultiplier);
    if (rewardAmount === 0) {
      return { ok: false, value: this.ERR_ZERO_REWARD };
    }

    const mintResp = this.ecoToken.mint(rewardAmount, verifiedData.farmer);
    if (!mintResp.ok) {
      return { ok: false, value: 107 }; // ERR_TOKEN_TRANSFER_FAILED
    }

    this.state.rewardedSubmissions.set(submissionId, { rewarded: true, amount: rewardAmount, timestamp: this.state.blockHeight });
    this.state.totalRewardsDistributed += rewardAmount;
    this.updateFarmerHistory(verifiedData.farmer, rewardAmount);
    this.dataVerifier.markRewarded(submissionId);
    this.incrementBlockHeight();

    return { ok: true, value: rewardAmount };
  }

  private calculateReward(qualityScore: number, metrics: Metrics, stakeMultiplier: number): number {
    const base = this.state.baseRewardRate;
    const carbonReward = metrics["carbon-sequestered"] * this.state.carbonMultiplier;
    const waterReward = metrics["water-saved"] * this.state.waterMultiplier;
    const yieldReward = metrics["yield-increase"] * this.state.yieldMultiplier;
    const subtotal = base + carbonReward + waterReward + yieldReward;
    const tierIndex = Math.floor(qualityScore / 34);
    const tierMul = this.state.rewardTierMultipliers[tierIndex] ?? 100;
    const tieredReward = Math.floor((subtotal * tierMul) / 100);
    const finalReward = Math.floor((tieredReward * stakeMultiplier) / 100);
    return Math.floor(finalReward / this.MICRO_ECO);
  }

  private updateFarmerHistory(farmer: string, amount: number) {
    const history = this.state.farmerRewardHistory.get(farmer) ?? { "total-rewards": 0, "last-claim": 0, "submission-count": 0 };
    this.state.farmerRewardHistory.set(farmer, {
      "total-rewards": history["total-rewards"] + amount,
      "last-claim": this.state.blockHeight,
      "submission-count": history["submission-count"] + 1,
    });
  }

  setConfig(
    caller: string,
    newBaseRate: number,
    newCarbonMul: number,
    newWaterMul: number,
    newYieldMul: number,
    newThreshold: number
  ): ClarityResponse<boolean> {
    if (caller !== this.state.contractOwner) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.baseRewardRate = newBaseRate;
    this.state.carbonMultiplier = newCarbonMul;
    this.state.waterMultiplier = newWaterMul;
    this.state.yieldMultiplier = newYieldMul;
    this.state.qualityThreshold = newThreshold;
    this.state.rewardConfigHistory.set(this.state.blockHeight, {
      "base-rate": newBaseRate,
      "carbon-mul": newCarbonMul,
      "water-mul": newWaterMul,
      "yield-mul": newYieldMul,
      threshold: newThreshold,
      timestamp: this.state.blockHeight,
    });
    this.incrementBlockHeight();
    return { ok: true, value: true };
  }

  setTierMultipliers(caller: string, newTiers: number[]): ClarityResponse<boolean> {
    if (caller !== this.state.contractOwner) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.rewardTierMultipliers = newTiers;
    return { ok: true, value: true };
  }

  pause(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.contractOwner) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.paused = true;
    return { ok: true, value: true };
  }

  unpause(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.contractOwner) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.paused = false;
    return { ok: true, value: true };
  }

  getRewardConfig(): ClarityResponse<RewardConfig> {
    return { ok: true, value: {
      "base-reward-rate": this.state.baseRewardRate,
      "carbon-multiplier": this.state.carbonMultiplier,
      "water-multiplier": this.state.waterMultiplier,
      "yield-multiplier": this.state.yieldMultiplier,
      "quality-threshold": this.state.qualityThreshold,
      "tier-multipliers": this.state.rewardTierMultipliers,
    } };
  }

  getTotalRewardsDistributed(): ClarityResponse<number> {
    return { ok: true, value: this.state.totalRewardsDistributed };
  }

  getRewardedSubmission(submissionId: number): ClarityResponse<RewardedSubmission | undefined> {
    return { ok: true, value: this.state.rewardedSubmissions.get(submissionId) };
  }

  getFarmerHistory(farmer: string): ClarityResponse<FarmerHistory | undefined> {
    return { ok: true, value: this.state.farmerRewardHistory.get(farmer) };
  }

  getConfigHistory(block: number): ClarityResponse<ConfigHistory | undefined> {
    return { ok: true, value: this.state.rewardConfigHistory.get(block) };
  }

  isContractPaused(): ClarityResponse<boolean> {
    return { ok: true, value: this.state.paused };
  }

  getOwner(): ClarityResponse<string> {
    return { ok: true, value: this.state.contractOwner };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  farmer1: "farmer1",
  unauthorized: "unauthorized",
};

describe("RewardDistributor Contract", () => {
  let contract: RewardDistributorMock;

  beforeEach(() => {
    contract = new RewardDistributorMock();
    vi.resetAllMocks();
  });

  it("should initialize with correct default config", () => {
    const config = contract.getRewardConfig();
    expect(config).toEqual({
      ok: true,
      value: {
        "base-reward-rate": 100,
        "carbon-multiplier": 50,
        "water-multiplier": 30,
        "yield-multiplier": 20,
        "quality-threshold": 50,
        "tier-multipliers": [100, 150, 200],
      },
    });
    expect(contract.getTotalRewardsDistributed()).toEqual({ ok: true, value: 0 });
    expect(contract.isContractPaused()).toEqual({ ok: true, value: false });
    expect(contract.getOwner()).toEqual({ ok: true, value: "deployer" });
  });

  it("should prevent distribution when paused", () => {
    contract.pause(accounts.deployer);
    const distribute = contract.distributeReward(accounts.deployer, 1);
    expect(distribute).toEqual({ ok: false, value: 105 });
  });

  it("should allow owner to update config", () => {
    const newConfig = contract.setConfig(
      accounts.deployer,
      200,
      60,
      40,
      25,
      60
    );
    expect(newConfig).toEqual({ ok: true, value: true });

    const updatedConfig = contract.getRewardConfig();
    expect(updatedConfig.value?.["base-reward-rate"]).toBe(200);
    expect(updatedConfig.value?.["carbon-multiplier"]).toBe(60);

    const configHistory = contract.getConfigHistory(1000);
    expect(configHistory.value?.["base-rate"]).toBe(200);
  });

  it("should prevent non-owner from updating config", () => {
    const update = contract.setConfig(
      accounts.unauthorized,
      200,
      60,
      40,
      25,
      60
    );
    expect(update).toEqual({ ok: false, value: 100 });
  });

  it("should allow owner to set tier multipliers", () => {
    const setTiers = contract.setTierMultipliers(accounts.deployer, [110, 160, 210]);
    expect(setTiers).toEqual({ ok: true, value: true });

    const config = contract.getRewardConfig();
    expect(config.value?.["tier-multipliers"]).toEqual([110, 160, 210]);
  });

  it("should pause and unpause contract by owner", () => {
    const pause = contract.pause(accounts.deployer);
    expect(pause).toEqual({ ok: true, value: true });
    expect(contract.isContractPaused()).toEqual({ ok: true, value: true });

    const unpause = contract.unpause(accounts.deployer);
    expect(unpause).toEqual({ ok: true, value: true });
    expect(contract.isContractPaused()).toEqual({ ok: true, value: false });
  });

  it("should prevent non-owner from pausing", () => {
    const pause = contract.pause(accounts.unauthorized);
    expect(pause).toEqual({ ok: false, value: 100 });
  });

  it("should handle zero reward calculation", () => {
    // Override mock to return low quality
    vi.spyOn(contract["dataVerifier"], "getVerifiedData").mockReturnValueOnce({
      ok: true,
      value: { "quality-score": 40, "impact-metrics": { "carbon-sequestered": 0, "water-saved": 0, "yield-increase": 0 }, farmer: "farmer1" },
    });

    const distribute = contract.distributeReward(accounts.deployer, 2);
    expect(distribute).toEqual({ ok: false, value: 108 }); // ERR_DATA_NOT_VERIFIED for low quality
  });
});