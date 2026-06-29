const text = `Pending confirmation

Amount

$31.62
will become final on Jun 30`;

// Test 1: non-greedy with mandatory $
const m1 = text.match(/Pending confirmation[\s\S]*?\$([\d.]+)[\s\S]*?will become final on (\w+\s+\d+)/i);
console.log('Test 1 (mandatory $):', m1 ? [m1[1], m1[2]] : 'no match');

// Test 2: find final on, then look backward for amount
const m2 = text.match(/will become final on (\w+\s+\d+)/i);
if (m2) {
    const idx = m2.index;
    const before = text.slice(0, idx);
    const m3 = before.match(/\$([\d.]+)/);
    console.log('Test 2 (split):', m3 ? [m3[1], m2[1]] : 'no match');
}

// Test 3: simpler regex approach
const amountMatch = text.match(/\$([\d.]+)/);
const dateMatch = text.match(/will become final on (\w+\s+\d+)/i);
console.log('Test 3 (separate):', amountMatch?.[1], dateMatch?.[1]);

// Test 4: with real page text format
const realText = `Scheduled payouts
Pending confirmation

Amount

$31.62
will become final on Jun 30

Payout date

Jul 16 or 17`;
const m4 = realText.match(/Pending confirmation[\s\S]*?\$([\d.]+)[\s\S]*?will become final on (\w+\s+\d+)/i);
console.log('Test 4 (real):', m4 ? [m4[1], m4[2]] : 'no match');