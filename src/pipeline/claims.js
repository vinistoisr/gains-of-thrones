// The physiological claims the page and the weekly AI note are allowed to make.
// brief.js and insights.js state facts from the data; anything beyond that
// (why a number matters for the body) has to be on this list, and the ai.js
// SYSTEM prompt renders these texts so the model is held to the same list.
// Each entry: id, the claim in plain words (text), where it comes from
// (source), the study size (n) and what was actually measured (protocol).
export const CLAIMS = [
  {
    id: "sets-growth-range",
    text: "Counting a set once for its main muscle and half for each assisting muscle: 1 to 3 weekly sets give a small return, 4 to 10 give most of the return per set, 11 to 18 is high and 19 or more is very high with no demonstrated ceiling; a muscle with 0 sets in a week is untrained.",
    source: "Pelland et al. 2025: meta-regression of weekly set volume, frequency and muscle growth across resistance training studies (fractional set counting, primary 1.0 and secondary 0.5)",
    n: "67 studies",
    protocol: "Meta-regression of resistance training studies on weekly fractional sets per muscle against measured muscle growth. Growth per set was highest in the low range and kept rising with diminishing returns at higher volumes, with no ceiling found in the data. The tiers are between-study marginal means, not one person's dose-response curve.",
  },
  {
    id: "sets-maintenance-dose",
    text: "Once size is built, about a third of the training volume holds it. Size is lost when training stops altogether.",
    source: "Bickel, Cross and Bamman 2011, Med Sci Sports Exerc 43(7): exercise dosing to retain resistance training adaptations in young and older adults",
    n: "70 adults (20-35 and 60-75 years)",
    protocol: "16 weeks of three sessions a week, then 32 weeks at one third of that volume, one ninth of it, or no training. Younger adults kept the muscle size they had gained on the reduced doses; the group that stopped lost it.",
  },
  {
    id: "cardio-no-interference",
    text: "Cardio done alongside lifting leaves muscle growth and maximal strength unchanged. Explosive strength shows a cost.",
    source: "Schumann et al. 2022, Sports Medicine 52(3): updated systematic review and meta-analysis on the compatibility of concurrent aerobic and strength training",
    n: "43 studies",
    protocol: "Meta-analysis comparing strength-only training with strength plus aerobic training. No significant difference in muscle size or maximal strength gains; explosive strength gains were smaller in the combined groups.",
  },
  {
    id: "vo2-endurance-response",
    text: "VO2 max moves with sustained cardio over weeks, intervals or steady effort alike. Lifting alone leaves it where it is.",
    source: "Milanovic, Sporis and Weston 2015, Sports Medicine 45(10): systematic review and meta-analysis of high-intensity interval training and continuous endurance training for VO2 max",
    n: "28 controlled trials",
    protocol: "Meta-analysis of controlled endurance training trials. VO2 max went up with both interval and continuous endurance training against no-exercise controls, a little more with intervals.",
  },
  {
    id: "e1rm-strength-signal",
    text: "Progression of estimated 1RM is a strength signal. Muscle size is a separate measure.",
    source: "Definition: e1RM is computed from load and reps (Epley 1985, Brzycki 1993) and estimates the heaviest single lift",
    n: null,
    protocol: "Definition. Strength and size are separate outcomes; the formulas estimate strength.",
  },
  {
    id: "rep-dropoff-effort",
    text: "Rep drop-off across sets at a fixed load says roughly how close the sets were to failure; the spread between people is too wide for a number, so only coarse states are read.",
    source: "Pooled rep counts from 29 studies of repeated sets to failure at a fixed load (set 2 near 70% of set 1, set 3 near 55%, set 4 near 50%); Nuzzo, Pinto, Kirsten and Steele 2024, Sports Medicine: meta-regression of repetitions to failure, with between-person variation too large for a point estimate",
    n: "29 studies",
    protocol: "Sets taken to failure at one load with the rep count of each set recorded. The mean decline by set number is stable; the spread between people is not, so the read is a state (near failure, moderate, easy, capped) and never a rep or RIR figure. Sets at a prescribed rep target carry no information.",
  },
  {
    id: "sleep-7h-floor",
    text: "Sleep under 7 hours a night is below the adult consensus floor.",
    source: "Watson et al. 2015, Sleep 38(6): joint consensus statement of the American Academy of Sleep Medicine and the Sleep Research Society",
    n: "Expert consensus panel, no study participants",
    protocol: "Consensus statement after a review of the published evidence: adults should sleep 7 or more hours per night on a regular basis.",
  },
];
