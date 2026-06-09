async function main() {
  try {
    const dashRes = await fetch("http://localhost:4111/dashboard-data");
    const dashData = await dashRes.json();
    console.log("Dashboard Data keys:", Object.keys(dashData));
    if (dashData.error) {
      console.log("Dashboard Data Error:", dashData.error);
    } else {
      console.log(`- transactions count: ${dashData.transactions?.length}`);
      console.log(`- top_merchants count: ${dashData.top_merchants?.length}`);
      console.log(`- holdings count: ${dashData.holdings?.length}`);
    }

    const txnRes = await fetch("http://localhost:4111/transactions");
    const txnData = await txnRes.json();
    console.log("\nTransactions API keys:", Object.keys(txnData));
    if (txnData.error) {
      console.log("Transactions API Error:", txnData.error);
    } else {
      console.log(`- transactions count: ${txnData.transactions?.length}`);
    }

  } catch (err: any) {
    console.error("API error:", err.message);
  }
}

main();
