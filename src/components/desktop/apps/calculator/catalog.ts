/** Everything the Calculator can do, for the Catalog, the F-key menus and the hints under the entry line. */

export type Category =
  | 'Algebra'
  | 'Calculus'
  | 'Numbers'
  | 'Trigonometry'
  | 'Lists & Statistics'
  | 'Probability'
  | 'Matrices & Vectors'
  | 'Complex'
  | 'Units'
  | 'Other';

export interface CatalogEntry {
  /** Name as a TI-89 spells it. */
  name: string;
  /** Arguments, optional ones in [brackets]. Absent for symbols and commands. */
  args?: string[];
  /** Text to insert, when it isn't `name(`. */
  insert?: string;
  desc: string;
  example?: string;
  category: Category;
}

export const CATALOG: CatalogEntry[] = [
  // Algebra (the TI-89's F2 menu)
  { name: 'solve', args: ['equation', 'variable'], desc: 'Solves an equation, inequality or system for real solutions. For a system, join equations with “and” and list the variables in braces.', example: 'solve(x^2-5x+6=0, x)', category: 'Algebra' },
  { name: 'factor', args: ['expression', '[variable]'], desc: 'Factors a polynomial or rational expression, or an integer into primes.', example: 'factor(x^3-8)', category: 'Algebra' },
  { name: 'expand', args: ['expression', '[variable]'], desc: 'Multiplies out products and powers.', example: 'expand((x+2)^3)', category: 'Algebra' },
  { name: 'zeros', args: ['expression', 'variable'], desc: 'The real values of the variable that make the expression zero, as a list.', example: 'zeros(x^3-x, x)', category: 'Algebra' },
  { name: 'approx', args: ['expression'], desc: 'The decimal value. Same as pressing ≈ (Ctrl+Enter).', example: 'approx(√(2))', category: 'Algebra' },
  { name: 'comDenom', args: ['expression'], desc: 'Combines terms over a common denominator.', example: 'comDenom(1/x+1/(x+1))', category: 'Algebra' },
  { name: 'propFrac', args: ['expression'], desc: 'Writes a rational expression as a polynomial plus a proper fraction.', example: 'propFrac((x^2+1)/(x-1))', category: 'Algebra' },
  { name: 'partfrac', args: ['expression'], desc: 'Partial fraction decomposition.', example: 'partfrac(1/(x^2-1))', category: 'Algebra' },
  { name: 'nSolve', args: ['equation', 'variable[=guess]'], desc: 'Finds one numeric solution, starting near the guess if given.', example: 'nSolve(cos(x)=x, x)', category: 'Algebra' },
  { name: 'simplify', args: ['expression'], desc: 'Simplifies an expression.', example: 'simplify(sin(x)^2+cos(x)^2)', category: 'Algebra' },
  { name: 'tExpand', args: ['expression'], desc: 'Expands trigonometric functions of sums and multiples.', example: 'tExpand(sin(2x))', category: 'Algebra' },
  { name: 'tCollect', args: ['expression'], desc: 'Collects products and powers of trig functions into multiple angles.', example: 'tCollect(sin(x)cos(x))', category: 'Algebra' },
  { name: 'getNum', args: ['fraction'], desc: 'The numerator.', example: 'getNum((x+1)/(x-1))', category: 'Algebra' },
  { name: 'getDenom', args: ['fraction'], desc: 'The denominator.', example: 'getDenom((x+1)/(x-1))', category: 'Algebra' },
  { name: 'left', args: ['equation'], desc: 'The left side of an equation.', example: 'left(2x+1=7)', category: 'Algebra' },
  { name: 'right', args: ['equation'], desc: 'The right side of an equation.', example: 'right(2x+1=7)', category: 'Algebra' },
  { name: 'collect', args: ['expression', '[variable]'], desc: 'Collects like terms.', example: 'collect(x*y+x*z+y, x)', category: 'Algebra' },
  { name: 'degree', args: ['polynomial', '[variable]'], desc: 'The degree of a polynomial.', example: 'degree(x^5+3x^2, x)', category: 'Algebra' },
  { name: 'quo', args: ['polynomial', 'polynomial', '[variable]'], desc: 'Quotient of polynomial division.', example: 'quo(x^3+1, x+1, x)', category: 'Algebra' },
  { name: 'rem', args: ['polynomial', 'polynomial', '[variable]'], desc: 'Remainder of polynomial division.', example: 'rem(x^3+2, x+1, x)', category: 'Algebra' },
  { name: 'exact', args: ['expression'], desc: 'Converts decimals to exact fractions.', example: 'exact(0.375)', category: 'Algebra' },
  { name: 'lnCollect', args: ['expression'], desc: 'Combines logarithms into one.', example: 'lnCollect(ln(x)+ln(y))', category: 'Algebra' },
  { name: 'lnExpand', args: ['expression'], desc: 'Expands logarithms of products and powers.', example: 'lnExpand(ln(x^2*y))', category: 'Algebra' },

  // Calculus (F3)
  { name: 'd', args: ['expression', 'variable', '[order]'], desc: 'Derivative. Add an order for higher derivatives.', example: 'd(x^3*sin(x), x)', category: 'Calculus' },
  { name: '∫', args: ['expression', 'variable', '[lower]', '[upper]'], desc: 'Antiderivative, or the definite integral when bounds are given.', example: '∫(x*e^(x), x, 0, 1)', category: 'Calculus' },
  { name: 'limit', args: ['expression', 'variable', 'point', '[direction]'], desc: 'Limit as the variable approaches the point. Direction -1 is from the left, 1 from the right.', example: 'limit(sin(x)/x, x, 0)', category: 'Calculus' },
  { name: 'Σ', args: ['expression', 'variable', 'low', 'high'], desc: 'Sum, also for symbolic and infinite bounds.', example: 'Σ(1/k^2, k, 1, ∞)', category: 'Calculus' },
  { name: 'Π', args: ['expression', 'variable', 'low', 'high'], desc: 'Product.', example: 'Π(k, k, 1, 10)', category: 'Calculus' },
  { name: 'taylor', args: ['expression', 'variable', 'order', '[point]'], desc: 'Taylor polynomial about the point (0 if not given).', example: 'taylor(e^(x), x, 4)', category: 'Calculus' },
  { name: 'deSolve', args: ['ode [and conditions]', 'independent', 'dependent'], desc: 'Solves 1st and 2nd order differential equations, with initial conditions joined by “and”. Write y′ as y\'.', example: "deSolve(y''+y=0 and y(0)=1 and y'(0)=0, x, y)", category: 'Calculus' },
  { name: 'fMin', args: ['expression', 'variable'], desc: 'Where the expression has its minimum.', example: 'fMin(x^2-4x, x)', category: 'Calculus' },
  { name: 'fMax', args: ['expression', 'variable'], desc: 'Where the expression has its maximum.', example: 'fMax(-x^2+6x, x)', category: 'Calculus' },
  { name: 'arcLen', args: ['expression', 'variable', 'start', 'end'], desc: 'Arc length of a curve.', example: 'arcLen(x^2, x, 0, 1)', category: 'Calculus' },
  { name: 'nDeriv', args: ['expression', 'variable', '[h]'], desc: 'Numeric derivative by central difference.', example: 'nDeriv(x^3, x)|x=2', category: 'Calculus' },
  { name: 'nInt', args: ['expression', 'variable', 'lower', 'upper'], desc: 'Numeric integral.', example: 'nInt(e^(-x^2), x, 0, 1)', category: 'Calculus' },
  { name: 'avgRC', args: ['expression', 'variable', '[h]'], desc: 'Average rate of change (forward difference).', example: 'avgRC(x^2, x, 0.1)|x=3', category: 'Calculus' },
  { name: 'series', args: ['expression', 'variable=point', 'order'], desc: 'Series expansion with its order term.', example: 'series(1/(1-x), x=0, 5)', category: 'Calculus' },
  { name: 'laplace', args: ['expression', 'variable', 'transform variable'], desc: 'Laplace transform.', example: 'laplace(sin(t), t, s)', category: 'Calculus' },
  { name: 'ilaplace', args: ['expression', 'variable', 'result variable'], desc: 'Inverse Laplace transform.', example: 'ilaplace(1/(s^2+1), s, t)', category: 'Calculus' },
  { name: 'grad', args: ['expression', '{variables}'], desc: 'Gradient vector.', example: 'grad(x^2*y, [x,y])', category: 'Calculus' },
  { name: 'tangent', args: ['expression', 'variable=point'], desc: 'Equation of the tangent line.', example: 'tangent(x^2, x=1)', category: 'Calculus' },

  // Numbers
  { name: '√', args: ['x'], desc: 'Square root.', example: '√(72)', category: 'Numbers' },
  { name: 'root', args: ['x', 'n'], desc: 'Real nth root.', example: 'root(-27, 3)', category: 'Numbers' },
  { name: 'abs', args: ['x'], desc: 'Absolute value.', example: 'abs(-3)', category: 'Numbers' },
  { name: 'ln', args: ['x'], desc: 'Natural logarithm.', example: 'ln(e^(2))', category: 'Numbers' },
  { name: 'log', args: ['x', '[base]'], desc: 'Logarithm, base 10 unless a base is given.', example: 'log(8, 2)', category: 'Numbers' },
  { name: 'e^', insert: 'e^(', desc: 'Exponential.', example: 'e^(1)', category: 'Numbers' },
  { name: '!', insert: '!', desc: 'Factorial.', example: '5!', category: 'Numbers' },
  { name: 'nCr', args: ['n', 'r'], desc: 'Combinations: n choose r.', example: 'nCr(10, 3)', category: 'Numbers' },
  { name: 'nPr', args: ['n', 'r'], desc: 'Permutations.', example: 'nPr(10, 3)', category: 'Numbers' },
  { name: 'gcd', args: ['a', 'b'], desc: 'Greatest common divisor (also of polynomials).', example: 'gcd(84, 36)', category: 'Numbers' },
  { name: 'lcm', args: ['a', 'b'], desc: 'Least common multiple.', example: 'lcm(4, 6)', category: 'Numbers' },
  { name: 'mod', args: ['a', 'b'], desc: 'Remainder of a÷b, with the sign of b.', example: 'mod(17, 5)', category: 'Numbers' },
  { name: 'isPrime', args: ['n'], desc: 'Whether n is prime.', example: 'isPrime(97)', category: 'Numbers' },
  { name: 'round', args: ['x', '[digits]'], desc: 'Rounds to a number of decimal places.', example: 'round(π, 3)', category: 'Numbers' },
  { name: 'floor', args: ['x'], desc: 'Greatest integer ≤ x.', example: 'floor(-2.5)', category: 'Numbers' },
  { name: 'ceiling', args: ['x'], desc: 'Least integer ≥ x.', example: 'ceiling(2.1)', category: 'Numbers' },
  { name: 'iPart', args: ['x'], desc: 'Integer part.', example: 'iPart(-3.7)', category: 'Numbers' },
  { name: 'fPart', args: ['x'], desc: 'Fractional part.', example: 'fPart(3.7)', category: 'Numbers' },
  { name: 'sign', args: ['x'], desc: '−1, 0 or 1.', example: 'sign(-4)', category: 'Numbers' },
  { name: 'max', args: ['a', 'b'], desc: 'The larger value (or largest in a list).', example: 'max(3, 7)', category: 'Numbers' },
  { name: 'min', args: ['a', 'b'], desc: 'The smaller value (or smallest in a list).', example: 'min({4,2,9})', category: 'Numbers' },
  { name: 'divisors', args: ['n'], desc: 'All divisors of n.', example: 'divisors(36)', category: 'Numbers' },
  { name: 'nextprime', args: ['n'], desc: 'The next prime after n.', example: 'nextprime(100)', category: 'Numbers' },

  // Trigonometry
  { name: 'sin', args: ['θ'], desc: 'Sine (in the angle mode).', example: 'sin(π/6)', category: 'Trigonometry' },
  { name: 'cos', args: ['θ'], desc: 'Cosine.', example: 'cos(π/4)', category: 'Trigonometry' },
  { name: 'tan', args: ['θ'], desc: 'Tangent.', example: 'tan(π/3)', category: 'Trigonometry' },
  { name: 'sin⁻¹', args: ['x'], desc: 'Inverse sine (arcsin).', example: 'sin⁻¹(1/2)', category: 'Trigonometry' },
  { name: 'cos⁻¹', args: ['x'], desc: 'Inverse cosine (arccos).', example: 'cos⁻¹(0)', category: 'Trigonometry' },
  { name: 'tan⁻¹', args: ['x'], desc: 'Inverse tangent (arctan).', example: 'tan⁻¹(1)', category: 'Trigonometry' },
  { name: 'sec', args: ['θ'], desc: 'Secant.', category: 'Trigonometry' },
  { name: 'csc', args: ['θ'], desc: 'Cosecant.', category: 'Trigonometry' },
  { name: 'cot', args: ['θ'], desc: 'Cotangent.', category: 'Trigonometry' },
  { name: 'sinh', args: ['x'], desc: 'Hyperbolic sine.', category: 'Trigonometry' },
  { name: 'cosh', args: ['x'], desc: 'Hyperbolic cosine.', category: 'Trigonometry' },
  { name: 'tanh', args: ['x'], desc: 'Hyperbolic tangent.', category: 'Trigonometry' },
  { name: '°', insert: '°', desc: 'Degrees, whatever the angle mode.', example: 'sin(30°)', category: 'Trigonometry' },
  { name: 'π', insert: 'π', desc: 'Pi.', category: 'Trigonometry' },

  // Lists & statistics
  { name: 'mean', args: ['list'], desc: 'Average.', example: 'mean({2,4,9})', category: 'Lists & Statistics' },
  { name: 'median', args: ['list'], desc: 'Median.', example: 'median({1,3,8,9})', category: 'Lists & Statistics' },
  { name: 'stdDev', args: ['list'], desc: 'Sample standard deviation.', example: 'stdDev({2,4,4,4,5,5,7,9})', category: 'Lists & Statistics' },
  { name: 'stdDevPop', args: ['list'], desc: 'Population standard deviation.', example: 'stdDevPop({2,4,4,4,5,5,7,9})', category: 'Lists & Statistics' },
  { name: 'variance', args: ['list'], desc: 'Sample variance.', example: 'variance({1,2,3,4})', category: 'Lists & Statistics' },
  { name: 'sum', args: ['list'], desc: 'Sum of a list’s elements.', example: 'sum({1,2,3})', category: 'Lists & Statistics' },
  { name: 'product', args: ['list'], desc: 'Product of a list’s elements.', example: 'product({1,2,3,4})', category: 'Lists & Statistics' },
  { name: 'seq', args: ['expression', 'variable', 'low', 'high', '[step]'], desc: 'Builds a list.', example: 'seq(n^2, n, 1, 6)', category: 'Lists & Statistics' },
  { name: 'cumSum', args: ['list'], desc: 'Running totals.', example: 'cumSum({1,2,3,4})', category: 'Lists & Statistics' },
  { name: 'SortA', args: ['list'], desc: 'Sorted ascending.', example: 'SortA({3,1,2})', category: 'Lists & Statistics' },
  { name: 'SortD', args: ['list'], desc: 'Sorted descending.', example: 'SortD({3,1,2})', category: 'Lists & Statistics' },
  { name: 'dim', args: ['list'], desc: 'Number of elements.', example: 'dim({5,6,7})', category: 'Lists & Statistics' },
  { name: 'quartiles', args: ['list'], desc: 'Min, Q1, median, Q3 and max.', example: 'quartiles({1,2,3,4,5,6,7,8})', category: 'Lists & Statistics' },
  { name: 'correlation', args: ['xlist', 'ylist'], desc: 'Correlation coefficient r.', example: 'correlation({1,2,3,4},{2,4,5,8})', category: 'Lists & Statistics' },
  { name: 'linear_regression', args: ['xlist', 'ylist'], desc: 'Slope and intercept (a, b) of the least-squares line y = ax + b.', example: 'linear_regression({1,2,3,4},{2,4,5,8})', category: 'Lists & Statistics' },
  { name: 'exponential_regression', args: ['xlist', 'ylist'], desc: 'a and b of y = b·aˣ.', category: 'Lists & Statistics' },
  { name: 'logarithmic_regression', args: ['xlist', 'ylist'], desc: 'a and b of y = a·ln(x) + b.', category: 'Lists & Statistics' },
  { name: 'power_regression', args: ['xlist', 'ylist'], desc: 'a and b of y = b·xᵃ.', category: 'Lists & Statistics' },
  { name: 'polynomial_regression', args: ['xlist', 'ylist', 'degree'], desc: 'Coefficients of the least-squares polynomial, highest power first.', example: 'polynomial_regression({0,1,2,3},{1,2,5,10},2)', category: 'Lists & Statistics' },

  // Probability
  { name: 'normcdf', args: ['lower', 'upper', '[μ]', '[σ]'], insert: 'normald_cdf(', desc: 'Normal distribution probability between two values. normald_cdf(μ, σ, lower, upper).', example: 'normald_cdf(0, 1, -1.96, 1.96)', category: 'Probability' },
  { name: 'invNorm', args: ['μ', 'σ', 'area'], insert: 'normald_icdf(', desc: 'The value with the given area to its left. normald_icdf(μ, σ, area).', example: 'normald_icdf(0, 1, 0.975)', category: 'Probability' },
  { name: 'normpdf', args: ['μ', 'σ', 'x'], insert: 'normald(', desc: 'Normal density.', example: 'normald(0, 1, 0)', category: 'Probability' },
  { name: 'binompdf', args: ['n', 'p', 'k'], insert: 'binomial(', desc: 'Binomial probability of exactly k successes.', example: 'binomial(10, 0.5, 3)', category: 'Probability' },
  { name: 'binomcdf', args: ['n', 'p', 'k'], insert: 'binomial_cdf(', desc: 'Binomial probability of at most k successes.', example: 'binomial_cdf(10, 0.5, 3)', category: 'Probability' },
  { name: 'poisson', args: ['λ', 'k'], desc: 'Poisson probability of exactly k.', example: 'poisson(3, 2)', category: 'Probability' },
  { name: 'tcdf', args: ['df', 'x'], insert: 'studentd_cdf(', desc: 'Student’s t cumulative probability up to x.', example: 'studentd_cdf(10, 2.228)', category: 'Probability' },
  { name: 'rand', args: ['[n]'], desc: 'Random number in [0,1), or a random integer 0…n−1.', example: 'rand()', category: 'Probability' },
  { name: 'randInt', args: ['low', 'high'], desc: 'Random integer.', example: 'randInt(1, 6)', category: 'Probability' },

  // Matrices & vectors
  { name: 'det', args: ['matrix'], desc: 'Determinant.', example: 'det([1,2;3,4])', category: 'Matrices & Vectors' },
  { name: 'rref', args: ['matrix'], desc: 'Reduced row echelon form.', example: 'rref([1,2,3;4,5,6])', category: 'Matrices & Vectors' },
  { name: 'ref', args: ['matrix'], desc: 'Row echelon form.', example: 'ref([1,2,3;4,5,6])', category: 'Matrices & Vectors' },
  { name: 'ᵀ', insert: 'ᵀ', desc: 'Transpose (also transpose(m)).', example: '[1,2;3,4]ᵀ', category: 'Matrices & Vectors' },
  { name: '⁻¹', insert: '^-1', desc: 'Inverse matrix.', example: '[1,2;3,4]^-1', category: 'Matrices & Vectors' },
  { name: 'identity', args: ['n'], desc: 'n×n identity matrix.', example: 'identity(3)', category: 'Matrices & Vectors' },
  { name: 'eigVl', args: ['matrix'], desc: 'Eigenvalues.', example: 'eigVl([2,1;1,2])', category: 'Matrices & Vectors' },
  { name: 'eigVc', args: ['matrix'], desc: 'Eigenvectors, as columns.', example: 'eigVc([2,1;1,2])', category: 'Matrices & Vectors' },
  { name: 'dotP', args: ['vector', 'vector'], desc: 'Dot product.', example: 'dotP([1,2,3],[4,5,6])', category: 'Matrices & Vectors' },
  { name: 'crossP', args: ['vector', 'vector'], desc: 'Cross product.', example: 'crossP([1,0,0],[0,1,0])', category: 'Matrices & Vectors' },
  { name: 'norm', args: ['vector or matrix'], desc: 'Length of a vector (Frobenius norm of a matrix).', example: 'norm([3,4])', category: 'Matrices & Vectors' },
  { name: 'unitV', args: ['vector'], desc: 'Unit vector.', example: 'unitV([3,4])', category: 'Matrices & Vectors' },
  { name: 'rank', args: ['matrix'], desc: 'Rank.', example: 'rank([1,2;2,4])', category: 'Matrices & Vectors' },
  { name: 'trace', args: ['matrix'], desc: 'Sum of the diagonal.', example: 'trace([1,2;3,4])', category: 'Matrices & Vectors' },
  { name: 'charpoly', args: ['matrix', 'variable'], desc: 'Characteristic polynomial.', example: 'charpoly([1,2;3,4], x)', category: 'Matrices & Vectors' },
  { name: 'kernel', args: ['matrix'], desc: 'Basis of the null space.', example: 'kernel([1,2;2,4])', category: 'Matrices & Vectors' },
  { name: 'linsolve', args: ['{equations}', '{variables}'], desc: 'Solves a linear system.', example: 'linsolve({x+y=3, x-y=1}, {x,y})', category: 'Matrices & Vectors' },
  { name: 'augment', args: ['a', 'b'], desc: 'Joins two matrices side by side, or two lists.', example: 'augment([1;2],[3;4])', category: 'Matrices & Vectors' },

  // Complex
  { name: 'cSolve', args: ['equation', 'variable'], desc: 'Solves allowing complex solutions.', example: 'cSolve(x^2+4=0, x)', category: 'Complex' },
  { name: 'cZeros', args: ['expression', 'variable'], desc: 'Complex zeros.', example: 'cZeros(x^3+1, x)', category: 'Complex' },
  { name: 'cFactor', args: ['expression'], desc: 'Factors over the complex numbers.', example: 'cFactor(x^2+1)', category: 'Complex' },
  { name: 'i', insert: 'i', desc: 'The imaginary unit.', example: '(2+3i)(1-i)', category: 'Complex' },
  { name: 'real', args: ['z'], desc: 'Real part.', example: 'real(3+4i)', category: 'Complex' },
  { name: 'imag', args: ['z'], desc: 'Imaginary part.', example: 'imag(3+4i)', category: 'Complex' },
  { name: 'conj', args: ['z'], desc: 'Complex conjugate.', example: 'conj(3+4i)', category: 'Complex' },
  { name: 'angle', args: ['z'], desc: 'Argument (angle) of a complex number.', example: 'angle(1+i)', category: 'Complex' },

  // Units
  { name: '▶', insert: '▶', desc: 'Converts to a unit, or ▶Dec for decimal.', example: '60_mi/_hr▶_m/_s', category: 'Units' },
  { name: '_m', insert: '_m', desc: 'Units start with an underscore: _m, _km, _ft, _in, _mi, _s, _hr, _kg, _lb, _N, _J, _W, _Pa, _L, _°C …', example: '3_ft+20_in▶_cm', category: 'Units' },

  // Other (F4 and the store/with keys)
  { name: 'Define', insert: 'Define ', desc: 'Defines a function you can use later.', example: 'Define f(x)=x^2-3x', category: 'Other' },
  { name: '→', insert: '→', desc: 'Stores a value in a variable (STO▶). Typing -> works too.', example: '5→a', category: 'Other' },
  { name: '|', insert: '|', desc: '“With”: evaluates with conditions, like x=3.', example: 'x^2+y|x=3 and y=1', category: 'Other' },
  { name: 'DelVar', insert: 'DelVar ', desc: 'Deletes variables.', example: 'DelVar a', category: 'Other' },
  { name: 'NewProb', insert: 'NewProb', desc: 'Starts a new problem: clears single-letter variables a–z.', category: 'Other' },
  { name: 'ans', args: ['n'], desc: 'The nth most recent answer.', example: 'ans(1)*2', category: 'Other' },
  { name: 'entry', args: ['n'], desc: 'The nth most recent entry.', example: 'entry(1)', category: 'Other' },
  { name: 'when', args: ['condition', 'true value', 'false value'], desc: 'Piecewise expression.', example: 'when(x<0, -x, x)', category: 'Other' },
  { name: 'subst', args: ['expression', 'variable=value'], desc: 'Substitutes a value.', example: 'subst(x^2+1, x=3)', category: 'Other' },
];

const byName = new Map(CATALOG.map((entry) => [entry.name.toLowerCase(), entry]));

/** The catalog entry for a function name as typed (any case). */
export function catalogEntry(name: string): CatalogEntry | undefined {
  return byName.get(name.toLowerCase());
}

/** What the catalog inserts for an entry. */
export function insertText(entry: CatalogEntry): string {
  return entry.insert ?? (entry.args ? `${entry.name}(` : entry.name);
}

/** The menus along the top of the home screen, like the TI-89's F2 to F4. */
export const HOME_MENUS: { label: string; key: string; items: (string | null)[] }[] = [
  {
    label: 'Algebra',
    key: 'F2',
    items: ['solve', 'factor', 'expand', 'zeros', 'approx', 'comDenom', 'propFrac', 'partfrac', 'nSolve', null, 'simplify', 'tExpand', 'tCollect', 'exact', null, 'cSolve', 'cFactor', 'cZeros'],
  },
  {
    label: 'Calc',
    key: 'F3',
    items: ['d', '∫', 'limit', 'Σ', 'Π', 'fMin', 'fMax', 'arcLen', 'taylor', 'nDeriv', 'nInt', 'deSolve', null, 'avgRC', 'tangent', 'laplace'],
  },
  {
    label: 'Other',
    key: 'F4',
    items: ['Define', '→', '|', 'DelVar', 'NewProb', null, 'ans', 'entry', 'when', null, 'nCr', 'nPr', 'gcd', 'lcm', 'mod', 'isPrime'],
  },
  {
    label: 'Matrix',
    key: 'F5',
    items: ['det', 'rref', 'ᵀ', '⁻¹', 'identity', 'eigVl', 'eigVc', null, 'dotP', 'crossP', 'norm', 'unitV', null, 'rank', 'kernel', 'linsolve'],
  },
  {
    label: 'Stats',
    key: 'F6',
    items: ['mean', 'median', 'stdDev', 'variance', 'quartiles', 'seq', 'SortA', null, 'correlation', 'linear_regression', 'polynomial_regression', null, 'normcdf', 'invNorm', 'binompdf', 'binomcdf'],
  },
];
