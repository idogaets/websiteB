int M1_IN1 = 4;
int M1_IN2 = 5;

void setup() {

  
}

void loop() {

digitalWrite(M1_IN1, HIGH);
digitalWrite(M1_IN2, LOW);
delay(2000);
digitalWrite(M1_IN1, LOW);
digitalWrite(M1_IN2, LOW);
delay(1000);

}
