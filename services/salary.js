function calculateWithholdingTax(annualSalary) {
  // Pakistan Withholding Tax 2025-26
  if (annualSalary <= 600000) return 0;
  if (annualSalary <= 1200000) return (annualSalary - 600000) * 0.025;
  if (annualSalary <= 2200000) return 6000 + (annualSalary - 1200000) * 0.11;
  if (annualSalary <= 3200000) return 116000 + (annualSalary - 2200000) * 0.23;
  if (annualSalary <= 4100000) return 346000 + (annualSalary - 3200000) * 0.30;
  return 616000 + (annualSalary - 4100000) * 0.35;
}

function calculateSalaryBreakdown(salaryComponents, daysInMonth = 30, daysWorked = 30) {
  const { basic_salary, house_rent, conveyance, medical, utilities } = salaryComponents;

  // Monthly totals
  const grossMonthly = parseFloat(basic_salary) + parseFloat(house_rent) +
                       parseFloat(conveyance) + parseFloat(medical) + parseFloat(utilities);

  // Annual for tax calculation
  const annualGross = grossMonthly * 12;
  const annualTax = calculateWithholdingTax(annualGross);
  const monthlyTax = annualTax / 12;

  // Monthly deductions
  const providentFund = grossMonthly * 0.025; // 2.5%
  const totalDeductions = providentFund + monthlyTax;
  const netMonthly = grossMonthly - totalDeductions;

  // Pro-rata for partial month
  const dailyRate = grossMonthly / daysInMonth;
  const grossProRata = dailyRate * daysWorked;
  const pfProRata = grossProRata * 0.025;
  const taxProRata = (monthlyTax / daysInMonth) * daysWorked;
  const deductionsProRata = pfProRata + taxProRata;
  const netProRata = grossProRata - deductionsProRata;

  return {
    // Monthly (full month)
    monthly: {
      basic: parseFloat(basic_salary),
      houseRent: parseFloat(house_rent),
      conveyance: parseFloat(conveyance),
      medical: parseFloat(medical),
      utilities: parseFloat(utilities),
      gross: grossMonthly,
      providentFund: providentFund,
      withholdingTax: monthlyTax,
      totalDeductions: totalDeductions,
      net: netMonthly
    },
    // Pro-rata (for partial month)
    proRata: {
      basic: (parseFloat(basic_salary) / daysInMonth) * daysWorked,
      houseRent: (parseFloat(house_rent) / daysInMonth) * daysWorked,
      conveyance: (parseFloat(conveyance) / daysInMonth) * daysWorked,
      medical: (parseFloat(medical) / daysInMonth) * daysWorked,
      utilities: (parseFloat(utilities) / daysInMonth) * daysWorked,
      gross: grossProRata,
      providentFund: pfProRata,
      withholdingTax: taxProRata,
      totalDeductions: deductionsProRata,
      net: netProRata,
      daysWorked: daysWorked,
      daysInMonth: daysInMonth
    }
  };
}

module.exports = { calculateWithholdingTax, calculateSalaryBreakdown };
