# Systems are graphs from day one; the node editor comes later

A System is stored and simulated as a general graph of Blocks, Ports and Connections from the first version, even though the first UI only offers Loop Templates and text editing. A node-graph editor (in the style of Simulink or Blender) is the intended long-term UI, and building on a fixed loop structure would force a data-model rewrite when it arrives. Loop Templates are therefore just pre-built graphs, and the text file is the graph's serialisation.
