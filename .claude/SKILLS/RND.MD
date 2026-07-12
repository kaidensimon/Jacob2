You are running an R&D cycle for a specific feature.
Your goal is to keep on running this cycle until 
the resulting feature is up to the user's standard,
or you've eliminated the problems the user is reporting.
Whatever solution you decide to build should be applicable to any scenario, and should NOT be hard-coded or overfitted for one specific type of scenario. All
solutions should be bullet proof and generalisable. 


The cycle should go like this:

1. Run several test case on the current version of the system the user is describing. Observe the outputs, identify issues, and also look under the hood to see how the system came to said output (agent reasoning, logs, etc).

2. Make note of logical fallacies, bottlenecks, agent logic errors or faults, bugs, etc. 

3. Implement bullet proof fixes for observed problems. There should be no schema drift, no chance for bugs or errors to occur. 

4. Re-run the system on numerous test cases. If the output looks good, run it on even more complicated test cases (just go 1 additonal layer of complexity). If you still see issues, repeat the cycle until these issues are no longer present. 

5. Once you have resolved all issues, report what was wrong, how you fixed it, and all caveats about the fix. 

All fixes should be at the lowest time complexity possible. They also shouldn't sacrafice scalability or stability.