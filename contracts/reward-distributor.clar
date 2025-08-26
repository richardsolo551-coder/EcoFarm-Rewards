;; RewardDistributor.clar
;; Core contract for distributing ECO token rewards to farmers based on verified eco-friendly farming data.
;; Integrates with DataVerifier.clar for verification status and EcoToken.clar for token minting.
;; Supports tiered rewards, multipliers for staked users, and admin-configurable parameters.

;; Traits
(define-trait eco-token-trait
  (
    (transfer (principal principal uint (optional (buff 34))) (response bool uint))
    (mint (uint principal) (response bool uint))
    (get-balance (principal) (response uint uint))
  )
)

(define-trait data-verifier-trait
  (
    (get-verified-data (uint) (response { quality-score: uint, impact-metrics: (tuple (carbon-sequestered uint) (water-saved uint) (yield-increase uint)), farmer: principal } uint))
    (mark-rewarded (uint) (response bool uint))
  )
)

(define-trait staking-pool-trait
  (
    (get-stake-multiplier (principal) (response uint uint))
  )
)

;; Constants
(define-constant ERR-NOT-AUTHORIZED u100)
(define-constant ERR-INVALID-SUBMISSION u101)
(define-constant ERR-ALREADY-REWARDED u102)
(define-constant ERR-INVALID-AMOUNT u103)
(define-constant ERR-CONFIG-UPDATE-FAILED u104)
(define-constant ERR-PAUSED u105)
(define-constant ERR-INVALID-MULTIPLIER u106)
(define-constant ERR-TOKEN-TRANSFER-FAILED u107)
(define-constant ERR-DATA-NOT-VERIFIED u108)
(define-constant ERR-INVALID-QUALITY-SCORE u109)
(define-constant ERR-ZERO-REWARD u110)

(define-constant BASE-REWARD-RATE u100) ;; Base reward in micro-ECO per submission
(define-constant CARBON-POINT-MULTIPLIER u50) ;; micro-ECO per ton of carbon sequestered
(define-constant WATER-POINT-MULTIPLIER u30) ;; micro-ECO per 1000 liters saved
(define-constant YIELD-POINT-MULTIPLIER u20) ;; micro-ECO per % yield increase
(define-constant QUALITY_THRESHOLD u50) ;; Minimum quality score for rewards (0-100)
(define-constant MAX_MULTIPLIER u200) ;; Max stake multiplier (200%)
(define-constant MICRO-ECO u1000000) ;; 1 ECO = 1,000,000 micro-ECO

;; Data Variables
(define-data-var contract-owner principal tx-sender)
(define-data-var paused bool false)
(define-data-var base-reward-rate uint BASE-REWARD-RATE)
(define-data-var carbon-multiplier uint CARBON-POINT-MULTIPLIER)
(define-data-var water-multiplier uint WATER-POINT-MULTIPLIER)
(define-data-var yield-multiplier uint YIELD-POINT-MULTIPLIER)
(define-data-var quality-threshold uint QUALITY_THRESHOLD)
(define-data-var eco-token-contract principal 'SP000000000000000000002Q6VF78.eco-token)
(define-data-var data-verifier-contract principal 'SP000000000000000000002Q6VF78.data-verifier)
(define-data-var staking-pool-contract principal 'SP000000000000000000002Q6VF78.staking-pool)
(define-data-var total-rewards-distributed uint u0)
(define-data-var reward-tier-multipliers (list 3 uint) (list u100 u150 u200))

;; Data Maps
(define-map rewarded-submissions
  { submission-id: uint }
  { rewarded: bool, amount: uint, timestamp: uint }
)
(define-map farmer-reward-history
  { farmer: principal }
  { total-rewards: uint, last-claim: uint, submission-count: uint }
)
(define-map reward-config-history
  { block: uint }
  { base-rate: uint, carbon-mul: uint, water-mul: uint, yield-mul: uint, threshold: uint, timestamp: uint }
)

;; Private Functions
(define-private (is-owner)
  (is-eq tx-sender (var-get contract-owner))
)

(define-private (calculate-reward (quality-score uint) (metrics (tuple (carbon-sequestered uint) (water-saved uint) (yield-increase uint))) (stake-multiplier uint))
  (let
    (
      (base (var-get base-reward-rate))
      (carbon-reward (* (get carbon-sequestered metrics) (var-get carbon-multiplier)))
      (water-reward (* (get water-saved metrics) (var-get water-multiplier)))
      (yield-reward (* (get yield-increase metrics) (var-get yield-multiplier)))
      (subtotal (+ base carbon-reward water-reward yield-reward))
      (tier-index (/ quality-score u34))
      (tier-mul (unwrap! (element-at? (var-get reward-tier-multipliers) tier-index) (err ERR-INVALID-QUALITY-SCORE)))
      (tiered-reward (/ (* subtotal tier-mul) u100))
      (final-reward (/ (* tiered-reward stake-multiplier) u100))
    )
    (if (> final-reward u0)
      (/ final-reward MICRO-ECO)
      u0
    )
  )
)

(define-private (update-farmer-history (farmer principal) (amount uint))
  (let
    (
      (history (default-to { total-rewards: u0, last-claim: u0, submission-count: u0 } (map-get? farmer-reward-history { farmer: farmer })))
    )
    (map-set farmer-reward-history
      { farmer: farmer }
      {
        total-rewards: (+ (get total-rewards history) amount),
        last-claim: block-height,
        submission-count: (+ (get submission-count history) u1)
      }
    )
  )
)

;; Public Functions
(define-public (distribute-reward (submission-id uint))
  (let
    (
      (verifier (contract-call? (var-get data-verifier-contract) get-verified-data submission-id))
      (verified-data (unwrap! verifier (err ERR-INVALID-SUBMISSION)))
      (quality-score (get quality-score verified-data))
      (metrics (get impact-metrics verified-data))
      (farmer (get farmer verified-data))
      (existing-reward (default-to { rewarded: false, amount: u0, timestamp: u0 } (map-get? rewarded-submissions { submission-id: submission-id })))
      (stake-multiplier (unwrap! (contract-call? (var-get staking-pool-contract) get-stake-multiplier farmer) (err ERR-INVALID-MULTIPLIER)))
    )
    (asserts! (not (var-get paused)) (err ERR-PAUSED))
    (asserts! (not (get rewarded existing-reward)) (err ERR-ALREADY-REWARDED))
    (asserts! (>= quality-score (var-get quality-threshold)) (err ERR-DATA-NOT-VERIFIED))
    (asserts! (<= stake-multiplier MAX_MULTIPLIER) (err ERR-INVALID-MULTIPLIER))
    (let
      (
        (reward-amount (calculate-reward quality-score metrics stake-multiplier))
      )
      (asserts! (> reward-amount u0) (err ERR-ZERO-REWARD))
      (try! (contract-call? (var-get eco-token-contract) mint reward-amount farmer))
      (map-set rewarded-submissions
        { submission-id: submission-id }
        { rewarded: true, amount: reward-amount, timestamp: block-height }
      )
      (var-set total-rewards-distributed (+ (var-get total-rewards-distributed) reward-amount))
      (update-farmer-history farmer reward-amount)
      (try! (contract-call? (var-get data-verifier-contract) mark-rewarded submission-id))
      (ok reward-amount)
    )
  )
)

(define-public (set-config (new-base-rate uint) (new-carbon-mul uint) (new-water-mul uint) (new-yield-mul uint) (new-threshold uint))
  (begin
    (asserts! (is-owner) (err ERR-NOT-AUTHORIZED))
    (var-set base-reward-rate new-base-rate)
    (var-set carbon-multiplier new-carbon-mul)
    (var-set water-multiplier new-water-mul)
    (var-set yield-multiplier new-yield-mul)
    (var-set quality-threshold new-threshold)
    (map-set reward-config-history
      { block: block-height }
      {
        base-rate: new-base-rate,
        carbon-mul: new-carbon-mul,
        water-mul: new-water-mul,
        yield-mul: new-yield-mul,
        threshold: new-threshold,
        timestamp: block-height
      }
    )
    (ok true)
  )
)

(define-public (set-tier-multipliers (new-tiers (list 3 uint)))
  (begin
    (asserts! (is-owner) (err ERR-NOT-AUTHORIZED))
    (var-set reward-tier-multipliers new-tiers)
    (ok true)
  )
)

(define-public (pause)
  (begin
    (asserts! (is-owner) (err ERR-NOT-AUTHORIZED))
    (var-set paused true)
    (ok true)
  )
)

(define-public (unpause)
  (begin
    (asserts! (is-owner) (err ERR-NOT-AUTHORIZED))
    (var-set paused false)
    (ok true)
  )
)

(define-public (set-eco-token-contract (new-contract principal))
  (begin
    (asserts! (is-owner) (err ERR-NOT-AUTHORIZED))
    (var-set eco-token-contract new-contract)
    (ok true)
  )
)

(define-public (set-data-verifier-contract (new-contract principal))
  (begin
    (asserts! (is-owner) (err ERR-NOT-AUTHORIZED))
    (var-set data-verifier-contract new-contract)
    (ok true)
  )
)

(define-public (set-staking-pool-contract (new-contract principal))
  (begin
    (asserts! (is-owner) (err ERR-NOT-AUTHORIZED))
    (var-set staking-pool-contract new-contract)
    (ok true)
  )
)

(define-public (transfer-ownership (new-owner principal))
  (begin
    (asserts! (is-owner) (err ERR-NOT-AUTHORIZED))
    (var-set contract-owner new-owner)
    (ok true)
  )
)

;; Read-Only Functions
(define-read-only (get-reward-config)
  {
    base-reward-rate: (var-get base-reward-rate),
    carbon-multiplier: (var-get carbon-multiplier),
    water-multiplier: (var-get water-multiplier),
    yield-multiplier: (var-get yield-multiplier),
    quality-threshold: (var-get quality-threshold),
    tier-multipliers: (var-get reward-tier-multipliers)
  }
)

(define-read-only (get-total-rewards-distributed)
  (var-get total-rewards-distributed)
)

(define-read-only (get-rewarded-submission (submission-id uint))
  (map-get? rewarded-submissions { submission-id: submission-id })
)

(define-read-only (get-farmer-history (farmer principal))
  (map-get? farmer-reward-history { farmer: farmer })
)

(define-read-only (get-config-history (block uint))
  (map-get? reward-config-history { block: block })
)

(define-read-only (is-contract-paused)
  (var-get paused)
)

(define-read-only (get-owner)
  (var-get contract-owner)
)