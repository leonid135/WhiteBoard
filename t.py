import  random
with open("1.txt","a+") as f:
    for i in range(300):
        f.write(f"{random.randint(-1000,1000)} ")