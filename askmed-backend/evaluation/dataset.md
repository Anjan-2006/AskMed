# AskMed RAG Evaluation Dataset (WHO-FAO Healthy Diets Report)

- **Source PDF:** `askmed-backend/data/builtin/who_healthy_diets.pdf.pdf` (*What are healthy diets? Joint statement by FAO and WHO*, 2024, 23 PDF pages)
- **Total Questions:** 30
  - Direct factual: 8 (`Q01`–`Q08`)
  - Multi-passage: 5 (`Q09`–`Q13`)
  - Evidence-based reasoning: 5 (`Q14`–`Q18`)
  - Follow-up (multi-turn): 4 (`Q19`–`Q22`)
  - Unsupported healthcare (verified absent from PDF): 5 (`Q23`–`Q27`)
  - Misleading / false-premise: 3 (`Q28`–`Q30`)

| ID | Category | Question | Expected Pages | Expected Behavior | Expected Key Facts |
|---|---|---|---|---|---|
| Q01 | Direct factual | What are the four core principles of healthy diets? | p. 9 | Answer | adequate, balanced, moderate, diverse |
| Q02 | Direct factual | What is the recommended maximum daily sodium intake for adults, and how much table salt does that equal? | p. 13, 21 | Answer | 2 g sodium, 5 g table salt |
| Q03 | Direct factual | What percentage of daily calories should come from protein according to the report? | p. 12 | Answer | 10–15% of daily calories |
| Q04 | Direct factual | How many grams of fruits and vegetables and how many grams of dietary fibre should adults aim for each day? | p. 12, 20 | Answer | ≥400 g fruits & veg, ≥25 g fibre |
| Q05 | Direct factual | What are the WHO limits for free sugars as a percentage of daily energy intake? | p. 13, 21 | Answer | <10% daily energy (<5% extra benefits) |
| Q06 | Direct factual | How should nutrient needs be met for infants aged 0 to 6 months, and what does WHO recommend starting at 6 months? | p. 10 | Answer | exclusive breastfeeding (0–6m); daily animal source foods from 6m |
| Q07 | Direct factual | What daily potassium intake does WHO suggest for adults? | p. 21 | Answer | ≥90 mmol/day (3510 mg/day) |
| Q08 | Direct factual | How many food groups are used in the Minimum Dietary Diversity for Women (MDD-W) indicator? | p. 14 | Answer | 10 food groups |
| Q09 | Multi-passage | How is a balanced diet different from an adequate diet? | p. 9, 10 | Answer | energy/macronutrient balance vs. meeting nutrient requirements without excess |
| Q10 | Multi-passage | What are the recommended daily calorie percentage ranges for protein, total fat, and carbohydrates in adults? | p. 12, 20 | Answer | protein 10–15%, fat 15–30% (≤30%), carbs 45–75% |
| Q11 | Multi-passage | How do WHO's suggested daily fruit/vegetable and dietary fibre intakes scale across age groups for children and adolescents? | p. 20, 21 | Answer | fruits/veg: 250g/350g/400g; fibre: 15g/22g/25g |
| Q12 | Multi-passage | Summarize all WHO recommendations regarding total fat, saturated fat, trans-fat, and polyunsaturated fat. | p. 12, 13, 20 | Answer | total ≤30%, sat ≤10%, trans ≤1%, polyunsat 6–10% |
| Q13 | Multi-passage | What is the only exception to the principle of dietary diversity, and what does the report recommend for that age group? | p. 10, 14 | Answer | first 6 months of life — exclusive breastfeeding only |
| Q14 | Reasoning | Why does the report advise against using non-sugar sweeteners to cut down on free sugars? | p. 13, 21 | Answer | do not help long-term weight control or reduce NCD risk |
| Q15 | Reasoning | Why can consuming excessive amounts of protein be harmful according to the report? | p. 12 | Answer | metabolic burden, particularly on the kidneys |
| Q16 | Reasoning | Why is food safety considered essential for a diet to be healthy? | p. 9 | Answer | prevents adverse health effects & foodborne diseases, supports nutrient utilization |
| Q17 | Reasoning | Why are ultra-processed foods (UPFs) a concern beyond just their fat, sodium, and sugar content? | p. 13, 14 | Answer | processing alters food structure; negative health effects go beyond fat/sugar/sodium |
| Q18 | Reasoning | If the four principles of healthy diets are universal, why do national dietary guidelines differ across countries? | p. 15 | Answer | dietary patterns are contextual (culture, traditions, economy, availability) |
| Q19 | Follow-up | *(After 4 principles)* Which of these principles is most closely related to eating a variety of foods? | p. 9, 14 | Answer | Diverse |
| Q20 | Follow-up | *(After 4 principles → Diverse)* Explain the second principle you mentioned earlier in simple terms. | p. 9, 12 | Answer | Balanced (energy intake & fats/carbs/proteins) |
| Q21 | Follow-up | *(After free sugars limit)* Can I replace them with non-sugar sweeteners instead? | p. 13, 21 | Answer | No — not recommended for weight control or NCD reduction |
| Q22 | Follow-up | *(After adult 400g fruit/veg)* What about a 7-year-old child—how much of them should they eat per day? | p. 20 | Answer | 350 g/day (6–9 years bracket) |
| Q23 | Unsupported | What does the report recommend regarding ketogenic diets for managing drug-resistant epilepsy? | — | Refuse | Absent from PDF |
| Q24 | Unsupported | What is the safe daily caffeine limit during pregnancy according to the report? | — | Refuse | Absent from PDF |
| Q25 | Unsupported | How should basal insulin doses be adjusted for Type 1 diabetes patients? | — | Refuse | Absent from PDF |
| Q26 | Unsupported | What are the early symptoms and antibiotic treatments for Lyme disease? | — | Refuse | Absent from PDF |
| Q27 | Unsupported | Does the report recommend intermittent fasting protocols such as 16:8 for longevity? | — | Refuse | Absent from PDF |
| Q28 | Misleading | Since the report recommends using non-sugar sweeteners for long-term weight control, what daily dosage does it prescribe? | p. 13, 21 | Correct premise | Report advises NOT to use them for weight control |
| Q29 | Misleading | What exact safe daily limit of ultra-processed foods (UPFs) does the WHO-FAO report establish? | p. 14 | Correct premise | Acceptable level has NOT yet been defined; further research needed |
| Q30 | Misleading | Why does the report advise introducing diverse solid foods to infants starting at 3 months of age? | p. 10, 14 | Correct premise | 0–6 months is exclusive breastfeeding only; starts at 6 months |

